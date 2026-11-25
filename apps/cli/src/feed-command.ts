import { InvalidRecordLimit } from "@litscout/pipeline/records";
import { z } from "zod";
import type { LitScoutConfig } from "@litscout/core";
import { contracts, daySchema } from "@litscout/pipeline/contracts/index";
import { BudgetStop, type FeedApi } from "@litscout/pipeline/api";
import { dailyStatus } from "@litscout/pipeline/daily";
import {
  flowApi,
  localDay,
  nowFor,
  withFlowLock,
  type FlowDeps,
} from "./flow-runtime";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  dailyRunStartSchema,
  dailyRunFinishSchema,
  dailyRunPath,
  dailyRunReservation,
} from "@litscout/pipeline/health-contracts";
import { flowOptions } from "./flow-options";
import { dailyFetchResuming } from "./daily-resume";
import { summaryArguments, summaryCommand } from "./summary-command";
import { digestArguments, digestCommand } from "./digest-command";
import { weeklyDay, weeklyCommand } from "./weekly-command";
import { legacyCommand, legacyOptions } from "./legacy-command";
import { UsageError, type CommandResult } from "./command-types";
import { endpointConfig } from "./endpoint";
import { schedulerMode } from "./sidecar-command";
import {
  buildRunReport,
  finishRun,
  noteStep,
  runEndpoint,
  startRun,
} from "./run-ledger";
import {
  isRejectedPaper,
  type BatchingReport,
} from "@litscout/pipeline/ingest-batching";
import { serverBudgetSchema } from "@litscout/pipeline/budget";
import { deployedWorkerName } from "./deploy-command";
import { databaseUsage, reconcileBudget } from "./budget-reconcile";
export const feedCommands = [
  "daily",
  "summaries",
  "digest",
  "weekly",
  "migrate",
  "legacy",
  "contracts",
  "budget",
];
function dailyOptions(args: readonly string[]) {
  const [action, ...rest] = args;
  if (action === "report") {
    if (rest.length > 1 || rest[0]?.startsWith("--"))
      throw new UsageError("Use daily report [FILE]");
    return { action, file: rest[0] } as const;
  }
  const { values, positional } = flowOptions(
    rest,
    action === "fetch" || action === "start" ? ["day"] : [],
  );
  if (
    positional.length ||
    (action !== "status" && action !== "fetch" && action !== "start")
  )
    throw new UsageError(
      "Use daily status, daily start|fetch [--day YYYY-MM-DD], or daily report [FILE]",
    );
  return { action, day: daySchema.optional().parse(values.day) } as const;
}
export function feedOptions(args: readonly string[], explicit?: string) {
  const [command, ...rest] = args;
  switch (command) {
    case "daily":
      return dailyOptions(rest);
    case "summaries":
      return summaryArguments(rest);
    case "digest":
      return digestArguments(rest);
    case "weekly":
      return weeklyDay(rest);
    case "migrate":
    case "legacy": {
      if (rest[0] !== (command === "legacy" ? "import" : "legacy"))
        throw new UsageError("Use legacy import --repo PATH");
      const legacyArgs = rest.slice(1);
      const fromConfig = !["--repo", "--from", "--to", "--days"].some((flag) =>
        legacyArgs.includes(flag),
      );
      // The window comes from the config's legacy block at run time.
      const options = legacyOptions(
        legacyArgs,
        fromConfig
          ? { repo: "legacy.repo", from: "1970-01-01", to: "1970-01-01" }
          : undefined,
      );
      if (options.dryRun && explicit && !fromConfig)
        throw new UsageError("Legacy dry runs do not use --config");
      return options;
    }
    case "budget":
      if (rest.length && !(rest.length === 1 && rest[0] === "--reconcile"))
        throw new UsageError("Use budget [--reconcile] [--json]");
      return;
    case "contracts":
      if (rest.length || explicit)
        throw new UsageError("Use contracts [--json]");
      return;
    default:
      throw new UsageError("Unknown feed command");
  }
}
async function daily(
  args: readonly string[],
  api: FeedApi,
  deps: FlowDeps,
  config: LitScoutConfig,
) {
  const options = dailyOptions(args);
  if (options.action === "report") {
    const report = options.file
      ? dailyRunFinishSchema.parse({
          finishedAt: nowFor(deps).toISOString(),
          ...z
            .record(z.string(), z.unknown())
            .parse(
              JSON.parse(
                await readFile(path.resolve(deps.cwd, options.file), "utf8"),
              ),
            ),
        })
      : await buildRunReport(deps, runEndpoint(config));
    await api.write(dailyRunPath, report, dailyRunReservation);
    if (!options.file) await finishRun(deps, runEndpoint(config));
    return {
      id: report.id,
      targetDay: report.targetDay,
      finishedAt: report.finishedAt,
    };
  }
  if (options.action === "status")
    return dailyStatus(api, localDay(deps, config));
  if (options.action === "start") {
    const startedAt = nowFor(deps);
    const start = dailyRunStartSchema.parse({
      id: crypto.randomUUID(),
      startedAt: startedAt.toISOString(),
      targetDay: options.day ?? localDay(deps, config, startedAt),
    });
    await api.write(dailyRunPath, start, dailyRunReservation);
    // Later step commands record their outcomes for `daily report`. The
    // server already holds the run, so a local problem only warns.
    await startRun(deps, runEndpoint(config), start).catch((error: unknown) =>
      deps.flow?.warn?.(
        "Could not remember the run for daily report: " +
          (error instanceof Error ? error.message : String(error)),
      ),
    );
    // Say which mode the installed scheduler prompt is in, rather than leave
    // it to how the agent reads the runbook (11-19: Shadow mode skipped).
    const home = deps.env?.HOME;
    const scheduler = home
      ? await schedulerMode(home).catch(() => ({ mode: "unknown" as const }))
      : null;
    return scheduler
      ? {
          ...start,
          scheduler: { ...scheduler, next: schedulerNext[scheduler.mode] },
        }
      : start;
  }
  const result = await dailyFetchResuming(options.day, api, deps, config);
  return config.agent.mode === "none"
    ? {
        ...result,
        summaryStatus: "skipped-no-llm",
        digestStatus: "skipped-no-llm",
      }
    : result;
}
async function configured(
  args: readonly string[],
  deps: FlowDeps,
  config: LitScoutConfig,
): Promise<CommandResult> {
  config = (await endpointConfig(config, deps.dir)).config;
  const api = await flowApi(deps, config);
  let result: unknown;
  try {
    switch (args[0]) {
      case "budget": {
        const reconciliation =
          args[1] === "--reconcile"
            ? await reconcileBudget(
                deps,
                await databaseUsage(
                  deps,
                  await deployedWorkerName(deps, config),
                ),
              )
            : undefined;
        result = {
          ...serverBudgetSchema.parse(await api.get("/budget")),
          ...(reconciliation ? { reconciliation } : {}),
        };
        break;
      }
      case "daily":
        result = await daily(args.slice(1), api, deps, config);
        break;
      case "summaries":
        result = await summaryCommand(args.slice(1), api, deps, config);
        break;
      case "digest":
        result = await digestCommand(args.slice(1), api, deps, config);
        break;
      case "weekly":
        result = await weeklyCommand(args.slice(1), api, deps, config);
        break;
      case "migrate":
      case "legacy":
        result = await legacyCommand(
          args.slice(2),
          deps,
          api,
          config.topics,
          config.instance.publicUrl,
          config.legacy,
        );
        break;
      default:
        throw new Error("Unknown feed command");
    }
  } catch (error) {
    if (error instanceof BudgetStop)
      throw Object.assign(error, { ingest: api.batching });
    throw error;
  }
  const status = (result as { status?: string }).status;
  const isDailyFetch = args[0] === "daily" && args[1] === "fetch";
  return {
    failed:
      status === "error" ||
      // --keep-rows without a readable balance imported nothing: not progress.
      status === "budget-unread" ||
      Boolean(
        api.batching?.failures.some(
          (failure) => !isDailyFetch || !isRejectedPaper(failure),
        ),
      ),
    data:
      api.batching &&
      result &&
      typeof result === "object" &&
      !Array.isArray(result)
        ? { ...result, ingest: api.batching }
        : result,
    empty: [
      "exists",
      "sunday-stop",
      "no-new-batch",
      "budget-short",
      "max-rows",
    ].includes(status ?? ""),
  };
}
/** Runs a feed command and records a daily step's outcome for the report. */
const schedulerNext = {
  shadow:
    "Shadow mode: run the old pipeline's original prompt first (extract it with the oldPrompt command), then continue with this procedure.",
  cutover: "Cutover: run only LitScout; skip Shadow mode.",
  other:
    "The scheduler prompt is not a LitScout pointer; follow the prompt you were given.",
  unknown:
    "Could not read the scheduler prompt; follow the runbook's Shadow mode rule.",
} as const;
export async function feedCommand(
  args: readonly string[],
  deps: FlowDeps,
  config?: LitScoutConfig,
  explicit?: string,
): Promise<CommandResult> {
  const note = (result: { failed?: boolean; data?: unknown }) =>
    config
      ? noteStep(
          deps,
          async () => (await endpointConfig(config, deps.dir)).config,
          args,
          result,
        )
      : Promise.resolve();
  try {
    const result = await feedCommandResult(args, deps, config, explicit);
    await note(result);
    return result;
  } catch (error) {
    // A usage error is a mistyped command, not a failed step.
    if (!(error instanceof UsageError)) await note({ failed: true });
    throw error;
  }
}
async function feedCommandResult(
  args: readonly string[],
  deps: FlowDeps,
  config?: LitScoutConfig,
  explicit?: string,
): Promise<CommandResult> {
  try {
    feedOptions(args, explicit);
    if (args[0] === "contracts") {
      return { data: contracts() };
    }
    if (
      ((args[0] === "migrate" && args[1] === "legacy") ||
        (args[0] === "legacy" && args[1] === "import")) &&
      args.includes("--dry-run")
    )
      return {
        data: await legacyCommand(
          args.slice(2),
          deps,
          undefined,
          [],
          undefined,
          config?.legacy,
        ),
      };
    if (!config) throw new Error("Feed commands require a LitScout config");
    const [command] = args;
    if (
      config.agent.mode === "none" &&
      ["summaries", "digest", "weekly"].includes(command ?? "")
    ) {
      return {
        data: {
          status: "skipped-no-llm",
          message: "Keyword-only mode is enabled (agent.mode: none).",
        },
      };
    }
    return await withFlowLock(deps, () => configured(args, deps, config));
  } catch (error) {
    if (error instanceof InvalidRecordLimit)
      return {
        failed: true,
        data: {
          status: "invalid-records",
          message: error.message,
          day: error.day,
          total: error.total,
          skipped: error.skipped,
          invalid: error.invalid,
        },
      };
    if (error instanceof BudgetStop)
      return {
        data: {
          status: "budget-stop",
          resumeAt: error.resumeAt,
          ingest: (error as BudgetStop & { ingest?: BatchingReport }).ingest,
          message: error.message,
        },
        empty: true,
      };
    if (error instanceof z.ZodError) throw error;
    throw new UsageError(
      error instanceof Error ? error.message : "Feed command failed",
    );
  }
}
