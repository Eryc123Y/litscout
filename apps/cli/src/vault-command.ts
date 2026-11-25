import type { LitScoutConfig } from "@litscout/core";
import type { z } from "zod";
import { vaultId } from "@litscout/pipeline/vault-contracts";
import {
  suggestionsPage,
  suggestionsQuery,
  suggestionResolution,
  workingPapersPage,
  workingPaperDetail,
} from "@litscout/pipeline/research-contracts";
import type { FeedApi } from "@litscout/pipeline/api";
import { BudgetStop } from "@litscout/pipeline/api";
import { QuotaExceeded } from "@litscout/pipeline/quota";
import {
  ideasPage,
  newVaultRequest,
  queuedReply,
  syncStage,
  vaultHash,
  vaultIdea,
} from "@litscout/pipeline/vault-contracts";
import { VaultError } from "@litscout/sync/vault-note";
import { flowOptions } from "./flow-options";
import { flowApi, localDay, withFlowLock, type FlowDeps } from "./flow-runtime";
import { UsageError, type CommandResult } from "./command-types";
import { syncVault } from "./vault-sync";
import { enableWrites, enableWritesOptions } from "./vault-enable";
import { endpointConfig } from "./endpoint";
import { noteStep } from "./run-ledger";

function syncOptions(rest: readonly string[]) {
  const usage =
    "Use sync [--dry-run] [--only index|requests|blocks|digests] [--adopt] [--json].";
  let options;
  try {
    options = flowOptions(rest, ["dry-run", "only", "adopt"]);
    if (options.positional.length) throw new Error(usage);
  } catch {
    throw new UsageError(usage);
  }
  const { values } = options;
  return {
    dryRun: values["dry-run"] === "true",
    only: syncStage.optional().parse(values.only),
    adopt: values.adopt === "true",
  };
}

export function vaultOptions(args: readonly string[]) {
  const [command, ...rest] = args;
  switch (command) {
    case "ideas":
      return { command, options: ideaOptions(rest) } as const;
    case "wp":
      return { command, options: workingPaperOptions(rest) } as const;
    case "suggestions":
      return { command, options: suggestionOptions(rest) } as const;
    case "sync":
      return { command, options: syncOptions(rest) } as const;
    case "enable-writes":
      return { command, options: enableWritesOptions(rest) } as const;
    default:
      throw new UsageError("Use sync, ideas, wp or suggestions");
  }
}

/** Runs a vault command; `sync` also counts as the daily report's sync step. */
export async function vaultCommand(
  args: readonly string[],
  deps: FlowDeps,
  config: LitScoutConfig,
) {
  const note = (result: { failed?: boolean; data?: unknown }) =>
    noteStep(
      deps,
      async () => (await endpointConfig(config, deps.dir)).config,
      args,
      result,
    );
  try {
    const result = await vaultCommandResult(args, deps, config);
    await note(result);
    return result;
  } catch (error) {
    // A usage error is a mistyped command, not a failed step.
    if (!(error instanceof UsageError)) await note({ failed: true });
    throw error;
  }
}
async function vaultCommandResult(
  args: readonly string[],
  deps: FlowDeps,
  config: LitScoutConfig,
) {
  const { command, options } = vaultOptions(args);
  if (command === "ideas") return ideas(options, deps, config);
  if (command === "wp") return workingPapers(options, deps, config);
  if (command === "suggestions") return suggestions(options, deps, config);
  if (command === "enable-writes") return enableWrites(options, deps, config);
  const { dryRun, only } = options;
  const writeFiles = config.vault.write && !dryRun && only !== "index";
  const work = async () => {
    const api = await flowApi(deps, config, { cacheBudget: writeFiles });
    const result = await syncVault(
      config.vault,
      deps.configDir ?? deps.cwd,
      api,
      {
        day: localDay(deps, config),
        dryRun,
        only,
        adopt: options.adopt,
      },
    );
    return { ...result, rowsWritten: api.batching?.rowsWritten ?? null };
  };
  try {
    const data = writeFiles ? await withFlowLock(deps, work) : await work();
    return {
      data: {
        ...data,
        messages: [
          data.summary,
          ...data.conventions.paperNotesWithoutIdentifiers.paths.map(
            (path) => "Paper note without arxiv or doi · " + path,
          ),
          ...(data.conventions.templates?.paths ?? []).map(
            (path) => "Template skipped · " + path,
          ),
          ...data.writes.map(
            ({ mode, kind, path }) => mode + " " + kind + " · " + path,
          ),
          ...data.rejected.map(
            ({ mode, id, reason }) =>
              (mode === "planned" ? "Would reject " : "Rejected ") +
              id +
              " · " +
              reason,
          ),
          ...data.handEdited.map((path) => "Hand-edited block kept · " + path),
          ...data.issues.map(({ path, reason }) => path + " · " + reason),
        ],
      },
    };
  } catch (error) {
    if (error instanceof VaultError) throw new UsageError(error.message);
    if (error instanceof BudgetStop || error instanceof QuotaExceeded)
      throw new UsageError(
        "Write budget reached. Run sync again after " + error.resumeAt + ".",
      );
    throw error;
  }
}

function ideaOptions(args: readonly string[]) {
  const [command, ...rest] = args;
  const usage =
    "Use ideas list, ideas show <id>, or ideas capture <title> [--body TEXT] [--paper ID].";
  if (command === "capture") {
    let options;
    try {
      options = flowOptions(rest, ["body", "paper"]);
    } catch {
      throw new UsageError(usage);
    }
    if (options.positional.length !== 1) throw new UsageError(usage);
    const input = newVaultRequest.parse({
      kind: "capture",
      title: options.positional[0],
      body: options.values.body,
      paperId: options.values.paper,
    });
    return { command, input } as const;
  }
  if (command === "show" && rest.length === 1)
    return { command, id: vaultHash.parse(rest[0]) } as const;
  if (command === "list" && rest.length === 0) return { command } as const;
  throw new UsageError(usage);
}

async function ideas(
  options: ReturnType<typeof ideaOptions>,
  deps: FlowDeps,
  config: LitScoutConfig,
): Promise<CommandResult> {
  if (options.command === "capture") {
    const response = queuedReply.parse(
      await (
        await flowApi(deps, config, { cacheBudget: false })
      ).write("/vault/requests", options.input, 12),
    );
    return { data: { ...response, messages: ["Queued idea " + response.id] } };
  }
  if (options.command === "show") {
    const api = await flowApi(deps, config, { cacheBudget: false });
    const idea = vaultIdea
      .nullable()
      .parse(await api.get("/ideas/" + options.id));
    return idea
      ? {
          data: {
            ...idea,
            messages: [idea.title, idea.path, idea.description ?? ""].filter(
              Boolean,
            ),
          },
        }
      : { data: { messages: ["Idea not found."] }, empty: true };
  }
  const api = await flowApi(deps, config, { cacheBudget: false });
  const items = await readPages(api, "/ideas", ideasPage);
  return {
    data: {
      items,
      messages: items.length
        ? items.map((idea) => idea.id + " · " + idea.title)
        : ["No indexed ideas."],
    },
    empty: !items.length,
  };
}

async function readPages<T>(
  api: FeedApi,
  route: string,
  schema: z.ZodType<{ items: T[]; next: string | null }>,
  query = new URLSearchParams(),
) {
  const items: T[] = [];
  do {
    const suffix = query.size ? "?" + query : "";
    const page = schema.parse(await api.get(route + suffix));
    items.push(...page.items);
    if (!page.next) break;
    query.set("after", page.next);
  } while (true);
  return items;
}

function workingPaperOptions(args: readonly string[]) {
  const [command, id, ...rest] = args;
  if (
    rest.length ||
    !((command === "show" && id) || (command === "list" && !id))
  )
    throw new UsageError("Use wp list or wp show <id>.");
  return id ? vaultHash.parse(id) : undefined;
}

async function workingPapers(
  id: ReturnType<typeof workingPaperOptions>,
  deps: FlowDeps,
  config: LitScoutConfig,
): Promise<CommandResult> {
  const api = await flowApi(deps, config, { cacheBudget: false });
  if (id) {
    const paper = workingPaperDetail
      .nullable()
      .parse(await api.get("/working-papers/" + id));
    if (!paper)
      return { data: { messages: ["Working paper not found."] }, empty: true };
    return {
      data: {
        ...paper,
        messages: [
          paper.title,
          paper.path,
          ...paper.ideas.map((idea, index) => index + 1 + ". " + idea.title),
          ...paper.reading.map((entry) =>
            [
              entry.title,
              entry.pending ? "waiting for sync" : entry.status,
              entry.vaultPath,
            ]
              .filter(Boolean)
              .join(" · "),
          ),
        ],
      },
    };
  }
  const items = await readPages(api, "/working-papers", workingPapersPage);
  return {
    data: {
      items,
      messages: items.length
        ? items.map((item) => item.id + " · " + item.title)
        : ["No indexed working papers."],
    },
    empty: !items.length,
  };
}

function suggestionOptions(args: readonly string[]) {
  const [command, ...rest] = args;
  const usage =
    "Use suggestions list [--day YYYY-MM-DD] [--status new|accepted|dismissed], suggestions accept <id>, or suggestions dismiss <id>.";
  if ((command === "accept" || command === "dismiss") && rest.length === 1)
    return { command, id: vaultId.parse(rest[0]) } as const;
  if (command !== "list") throw new UsageError(usage);
  const options = flowOptions(rest, ["day", "status"]);
  if (options.positional.length) throw new UsageError(usage);
  return { command, filter: suggestionsQuery.parse(options.values) } as const;
}

async function suggestions(
  options: ReturnType<typeof suggestionOptions>,
  deps: FlowDeps,
  config: LitScoutConfig,
): Promise<CommandResult> {
  const { command } = options;
  if (options.command !== "list") {
    const { id } = options;
    const api = await flowApi(deps, config, { cacheBudget: false });
    const result = suggestionResolution.parse(
      await api.write("/suggestions/" + id + "/" + command, {}, 12),
    );
    return {
      data: {
        ...result,
        messages: [
          result.requestId
            ? "Waiting for sync · " + result.requestId
            : "Dismissed " + id,
        ],
      },
    };
  }
  const { filter } = options;
  const query = new URLSearchParams();
  if (filter.day) query.set("day", filter.day);
  if (filter.status) query.set("status", filter.status);
  const api = await flowApi(deps, config, { cacheBudget: false });
  const items = await readPages(api, "/suggestions", suggestionsPage, query);
  return {
    data: {
      items,
      messages: items.length
        ? items.map((item) =>
            [item.id, item.day, item.status, item.title].join(" · "),
          )
        : ["No suggestions."],
    },
    empty: !items.length,
  };
}
