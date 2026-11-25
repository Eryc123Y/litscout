import { rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { LitScoutConfig } from "@litscout/core";
import { BackupError, verifyBackup } from "@litscout/pipeline/backup";
import type { BackupBundle } from "@litscout/pipeline/backup-contracts";
import {
  restoreBackup,
  RestoreBudgetStop,
  RestoreError,
  restorePlan,
} from "@litscout/pipeline/backup-restore";
import {
  restorePath,
  restorePersonalSections,
  restoreResultSchema,
  restoreStatusSchema,
  type RestorePage,
} from "@litscout/pipeline/backup-restore-contracts";
import { readBundle } from "./backup-file";
import {
  readCheckpoint,
  resumeDirectory,
  resumePath,
  writeCheckpoint,
} from "./checkpoint-store";
import { UsageError, type CommandResult } from "./command-types";
import { endpointConfig } from "./endpoint";
import { flowOptions, integerOption } from "./flow-options";
import { credential, type FlowDeps } from "./flow-runtime";

const usage =
  "Use backup restore FILE [--dry-run] [--max-rows N | --keep-rows N]";

export function restoreOptions(args: readonly string[]) {
  let parsed;
  try {
    parsed = flowOptions(args, ["dry-run", "max-rows", "keep-rows"]);
  } catch {
    throw new UsageError(usage);
  }
  const { values, positional } = parsed;
  if (positional.length !== 1) throw new UsageError(usage);
  const maxRows = values["max-rows"];
  const keepRows = values["keep-rows"];
  if (maxRows !== undefined && keepRows !== undefined)
    throw new UsageError("Use --max-rows or --keep-rows, not both");
  if ((maxRows ?? keepRows) !== undefined && values["dry-run"])
    throw new UsageError(
      "--max-rows and --keep-rows apply only when restoring",
    );
  const rows = (value: string | undefined) =>
    value === undefined
      ? undefined
      : integerOption(value, 0, Number.MAX_SAFE_INTEGER);
  return {
    file: positional[0]!,
    dryRun: values["dry-run"] === "true",
    maxRows: rows(maxRows),
    keepRows: rows(keepRows),
  };
}

const count = z.number().int().nonnegative();
const checkpointSchema = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  next: count,
  pages: count,
  inserted: count,
  skipped: count,
  rowsWritten: count,
});
const budgetSchema = z.object({ used: count, reserved: count, limit: count });
const failureSchema = z
  .object({ error: z.object({ code: z.string(), message: z.string() }) })
  .partial()
  .nullable();

type Call = (route: string, init?: RequestInit) => Promise<Response>;

async function readData<T>(call: Call, route: string, schema: z.ZodType<T>) {
  const response = await call(route);
  if (!response.ok)
    throw new UsageError(
      `The instance did not answer ${route} (HTTP ${response.status}).`,
    );
  const body = (await response.json()) as { data?: unknown };
  return schema.parse(body.data);
}

function writer(call: Call) {
  return async (page: RestorePage) => {
    const response = await call(restorePath, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(page),
    });
    const body = (await response.json().catch(() => null)) as {
      data?: unknown;
      meta?: { rowsWritten?: unknown };
    } | null;
    if (!response.ok) {
      const error = failureSchema.safeParse(body).data?.error;
      if (response.status === 429 && error?.code === "WRITE_BUDGET_EXCEEDED")
        throw new RestoreBudgetStop();
      throw new UsageError(
        `Restore of ${page.section} failed (HTTP ${response.status})${error?.message ? `: ${error.message}` : "."}`,
      );
    }
    return {
      ...restoreResultSchema.parse(body?.data),
      rowsWritten: count.parse(body?.meta?.rowsWritten ?? 0),
    };
  };
}

/** Name the sections that make an instance not empty. */
function heldRows(counts: Record<string, number>) {
  return restorePersonalSections
    .filter((section) => counts[section]! > 0)
    .map((section) => `${section} ${counts[section]}`)
    .join(", ");
}

function verified(bundle: BackupBundle) {
  try {
    const warnings = verifyBackup(bundle);
    return { warnings, plan: restorePlan(bundle) };
  } catch (error) {
    if (error instanceof BackupError || error instanceof RestoreError)
      throw new UsageError(error.message);
    throw error;
  }
}

export async function restoreCommand(
  args: readonly string[],
  deps: FlowDeps,
  loadConfig: () => Promise<LitScoutConfig>,
): Promise<CommandResult> {
  const options = restoreOptions(args);
  const file = path.resolve(deps.cwd, options.file);
  // Check the export offline before contacting the instance.
  const bundle = await readBundle(file);
  const { warnings, plan } = verified(bundle);

  const { config } = await endpointConfig(await loadConfig(), deps.dir);
  const base = config.instance.publicUrl;
  if (!base)
    throw new UsageError(
      "Set instance.publicUrl before running backup restore",
    );
  const token = await credential(deps, base);
  const call: Call = (route, init = {}) =>
    deps.fetch(new URL(`/api/v1${route}`, base), {
      ...init,
      headers: {
        Accept: "application/json",
        ...init.headers,
        authorization: `Bearer ${token}`,
      },
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });

  const checkpoint = path.join(
    resumePath(deps.dir, base),
    `restore-${bundle.sha256.slice(0, 32)}.json`,
  );
  const stored = await readCheckpoint(checkpoint, checkpointSchema, 4096);
  // A saved place belongs to this export and this page split only.
  const matching =
    stored?.sha256 === bundle.sha256 && stored.pages === plan.pages
      ? stored
      : null;
  const instance = await readData(call, restorePath, restoreStatusSchema);
  // Past the personal pages, but none of their rows are left: the instance
  // was reset since the pause, so start again from the first page.
  const restarted =
    matching !== null &&
    instance.personalRows === 0 &&
    matching.next > plan.firstPersonalPage;
  const saved = restarted ? null : matching;
  if (!saved && instance.personalRows > 0)
    throw new UsageError(
      `This instance already has ${instance.personalRows} personal row${instance.personalRows === 1 ? "" : "s"} (${heldRows(instance.counts)}). Restore only into a new, empty instance.`,
    );
  const needsBudget = options.dryRun || options.keepRows !== undefined;
  const budget = needsBudget
    ? await readData(call, "/budget", budgetSchema)
    : undefined;
  const balance = budget && budget.limit - budget.used - budget.reserved;
  const { instanceName, createdAt } = bundle;
  if (options.dryRun)
    return {
      data: {
        dryRun: true,
        file,
        instanceName,
        createdAt,
        warnings,
        rows: plan.rows,
        pages: plan.pages,
        maxRowsWritten: plan.maxRowsWritten,
        resumeAt: saved?.next ?? 0,
        balance,
        fitsToday: balance !== undefined && plan.maxRowsWritten <= balance,
      },
    };

  const maxRows =
    options.maxRows ??
    (options.keepRows === undefined || balance === undefined
      ? undefined
      : Math.max(0, balance - options.keepRows));
  await resumeDirectory(deps.dir, base);
  const result = await restoreBackup(writer(call), bundle, {
    from: saved?.next ?? 0,
    totals: saved ?? undefined,
    maxRows,
    onPage: (progress) =>
      writeCheckpoint(checkpoint, { sha256: bundle.sha256, ...progress }, 4096),
  });
  if (result.status === "done") await rm(checkpoint, { force: true });
  const { status, ...progress } = result;
  return {
    data: {
      status: status === "done" ? "done" : "paused",
      ...(status === "budget" && {
        reason: "budget",
        resume:
          "Run the same command after the daily write budget resets. It continues from the saved page.",
      }),
      ...(restarted && { restarted: true }),
      file,
      warnings,
      ...progress,
    },
  };
}
