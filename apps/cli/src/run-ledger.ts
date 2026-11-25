/**
 * The Health run report, built by the CLI instead of the scheduled agent.
 * `daily start` leaves a pointer to the run; each step command adds one line
 * to the run's ledger; `daily report` with no file turns the ledger into the
 * report. Only statuses, error labels, client names and row counts are kept:
 * never command output or diagnostic text.
 */
import { appendFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { clientSchema } from "@litscout/core/agent-config";
import {
  dailyRunFinishSchema,
  dailyRunStartSchema,
} from "@litscout/pipeline/health-contracts";
import {
  readCheckpoint,
  resumeDirectory,
  resumePath,
} from "./checkpoint-store";
import { privateJson } from "./state";

export const runSteps = [
  "fetch",
  "summaries",
  "digest",
  "sync",
  "legacy",
] as const;
export type RunStep = (typeof runSteps)[number];
/** `start` is not a report step; it only adds `daily start`'s rows to the total. */
type LedgerStep = RunStep | "start";
type StepError =
  | "budget"
  | "client-unavailable"
  | "source-unavailable"
  | "invalid-output"
  | "operation-failed";
export type StepOutcome = {
  status: "done" | "skipped" | "pending" | "paused" | "failed";
  client?: z.output<typeof clientSchema>;
  fallback?: boolean;
  error?: StepError;
};
type CommandOutcome = { failed?: boolean; data?: unknown };
type LedgerDeps = { dir: string; flow?: { now?: () => Date } };

/** A run older than this no longer collects steps (a crashed run's pointer). */
const runLifetimeMs = 6 * 60 * 60 * 1000;
const pointerFile = "run-current.json";
const pointerSchema = dailyRunStartSchema.extend({ endpoint: z.string() });
const lineSchema = z.strictObject({
  step: z.enum([...runSteps, "start"]),
  status: z.enum(["done", "skipped", "pending", "paused", "failed"]),
  client: clientSchema.optional(),
  fallback: z.boolean().optional(),
  error: z
    .enum([
      "budget",
      "client-unavailable",
      "source-unavailable",
      "invalid-output",
      "operation-failed",
    ])
    .optional(),
  rows: z.number().int().nonnegative().nullable(),
  /** The reading day a summaries or digest run worked on. */
  day: z.iso.date().optional(),
});

const now = (deps: LedgerDeps) => deps.flow?.now?.() ?? new Date();

/** The instance a run belongs to, as the checkpoints key it. */
export const runEndpoint = (config: { instance: { publicUrl?: string } }) =>
  config.instance.publicUrl ?? "configured-instance";

/** The report step a command belongs to; null for previews and other commands. */
export function stepFor(args: readonly string[]): LedgerStep | null {
  const [command, action] = args;
  const preview = args.includes("--dry-run");
  if (command === "daily" && action === "start") return "start";
  if (command === "daily" && action === "fetch") return "fetch";
  // `put` is the runbook's manual path: a draft written by hand when the
  // automatic run could not finish. It is the same step's work.
  const writes = action === "run" || action === "put";
  if (command === "summaries" && writes && !preview) return "summaries";
  if (command === "digest" && writes && !preview) return "digest";
  if (
    ((command === "legacy" && action === "import") ||
      (command === "migrate" && action === "legacy")) &&
    !preview
  )
    return "legacy";
  // Shadow mode runs sync as a preview every time; it still counts as the step.
  if (command === "sync") return "sync";
  return null;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const budgetStatuses = new Set(["budget-short", "budget-stop"]);
const skippedStatuses = new Set([
  "exists",
  "no-new-batch",
  "sunday-stop",
  "skipped-no-llm",
]);
// `partial`: some summaries failed or were left over; the next run takes them.
const pendingStatuses = new Set([
  "pending",
  "partial",
  "summaries-pending",
  "needs-digest",
]);

/**
 * Why summaries are still pending, from the chunk failures the run reported:
 * a client that timed out or exited first (the likelier cause to look at),
 * then answers that came back incomplete, invalid or quarantined.
 */
function pendingReason(
  step: LedgerStep,
  data: Record<string, unknown>,
): { error?: StepError } {
  if (step !== "summaries" || !Array.isArray(data.failures)) return {};
  const failures = data.failures.filter(
    (failure): failure is string => typeof failure === "string",
  );
  if (
    failures.some((failure) =>
      // A client that cannot start reports as "client exited 1".
      /agent timed out|client exited/.test(failure),
    )
  )
    return { error: "client-unavailable" };
  if (
    failures.some((failure) =>
      /complete after a retry|invalid summary JSON|quarantined output/.test(
        failure,
      ),
    )
  )
    return { error: "invalid-output" };
  return {};
}

/** Maps one command's result to the report's step fields. */
export function stepOutcome(
  step: LedgerStep,
  result: CommandOutcome,
): StepOutcome {
  const data = record(result.data);
  const status = typeof data.status === "string" ? data.status : undefined;
  const used = Array.isArray(data.clientsUsed) ? data.clientsUsed : [];
  const client = clientSchema.safeParse(used.at(-1));
  const agent = {
    ...(client.success ? { client: client.data } : {}),
    ...(Array.isArray(data.fallback) && data.fallback.length > 0
      ? { fallback: true }
      : {}),
  };
  if (status && budgetStatuses.has(status))
    return { status: "paused", error: "budget" };
  if (status === "invalid-records")
    return { status: "failed", error: "invalid-output" };
  if (result.failed || status === "error" || status === "budget-unread")
    return { status: "failed", error: "operation-failed" };
  // The fetch's status is the day's state (`pending` while its listing is
  // due), not the step's: the fetch itself did its work.
  if (
    step === "fetch" &&
    (status === "pending" || status === "exists" || status === "crawled")
  )
    return { status: "done" };
  // A capped legacy slice stopped to keep the day's rows: it resumes later.
  if (step === "legacy" && status === "max-rows")
    return { status: "paused", error: "budget" };
  if (status && skippedStatuses.has(status)) return { status: "skipped" };
  // A client's usage gate stopped the run.
  if (status === "paused")
    return { status: "paused", error: "client-unavailable" };
  if (status && pendingStatuses.has(status))
    return { status: "pending", ...agent, ...pendingReason(step, data) };
  return { status: "done", ...agent };
}

/**
 * Several runs of one step: the latest run that did something stands, so a
 * retry that finished the work replaces an earlier partial or failed run, and
 * a later "nothing new" does not undo earlier work.
 */
export function combineOutcomes(outcomes: readonly StepOutcome[]): StepOutcome {
  return (
    outcomes.filter((outcome) => outcome.status !== "skipped").at(-1) ?? {
      status: "skipped",
    }
  );
}

/** Rows a command confirmed writing; null when it reported none. */
function confirmedRows(step: LedgerStep, result: CommandOutcome) {
  const data = record(result.data);
  const rows =
    step === "sync" ? data.rowsWritten : record(data.ingest).rowsWritten;
  return typeof rows === "number" && Number.isInteger(rows) && rows >= 0
    ? rows
    : null;
}

// Reading creates nothing: a command with no run in progress leaves no trace.
async function currentRun(deps: LedgerDeps, endpoint: string) {
  const folder = resumePath(deps.dir, endpoint);
  const pointer = await readCheckpoint(
    path.join(folder, pointerFile),
    pointerSchema,
    4096,
  );
  return pointer && pointer.endpoint === endpoint
    ? { folder, pointer }
    : { folder, pointer: null };
}

/** Called by `daily start` after the server accepted the run. */
export async function startRun(
  deps: LedgerDeps,
  endpoint: string,
  start: z.output<typeof dailyRunStartSchema>,
) {
  const folder = await resumeDirectory(deps.dir, endpoint);
  // A run that never reported leaves its ledger behind; drop it.
  const previous = await readCheckpoint(
    path.join(folder, pointerFile),
    pointerSchema,
    4096,
  ).catch(() => null);
  if (previous && previous.id !== start.id)
    await rm(path.join(folder, `run-${previous.id}.jsonl`), { force: true });
  await privateJson(path.join(folder, pointerFile), { ...start, endpoint });
  return folder;
}

/** Adds a step command's outcome to the run in progress, if there is one. */
export async function recordStep(
  deps: LedgerDeps,
  endpoint: string,
  args: readonly string[],
  result: CommandOutcome,
) {
  const step = stepFor(args);
  // A start the server refused opened no run; leave any open run alone.
  if (!step || (step === "start" && result.failed)) return;
  const { folder, pointer } = await currentRun(deps, endpoint);
  if (!pointer) return;
  const age = now(deps).getTime() - Date.parse(pointer.startedAt);
  if (age < 0 || age > runLifetimeMs) return;
  const day = z.iso.date().safeParse(record(result.data).day);
  const line = lineSchema.parse({
    step,
    ...stepOutcome(step, result),
    rows: confirmedRows(step, result),
    ...(day.success && (step === "summaries" || step === "digest")
      ? { day: day.data }
      : {}),
  });
  await appendFile(
    path.join(folder, `run-${pointer.id}.jsonl`),
    JSON.stringify(line) + "\n",
    { mode: 0o600 },
  );
}

async function ledgerLines(folder: string, id: string) {
  const text = await readFile(
    path.join(folder, `run-${id}.jsonl`),
    "utf8",
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return text.split("\n").flatMap((raw) => {
    if (!raw.trim()) return [];
    try {
      const parsed = lineSchema.safeParse(JSON.parse(raw));
      return parsed.success ? [parsed.data] : [];
    } catch {
      return [];
    }
  });
}

/** The finished report for the run in progress. */
export async function buildRunReport(deps: LedgerDeps, endpoint: string) {
  const { folder, pointer } = await currentRun(deps, endpoint);
  if (!pointer)
    throw new Error(
      "No daily run in progress. Run daily start first, or pass a report FILE.",
    );
  // A crashed run's pointer must not become a later day's report.
  const age = now(deps).getTime() - Date.parse(pointer.startedAt);
  if (age < 0 || age > runLifetimeMs)
    throw new Error(
      "The open daily run started more than six hours ago. Run daily start for a new run, or pass a report FILE.",
    );
  const lines = await ledgerLines(folder, pointer.id);
  const steps = Object.fromEntries(
    runSteps.map((step) => {
      const { status, client, fallback, error } = combineOutcomes(
        lines.filter((line) => line.step === step),
      );
      return [
        step,
        {
          status,
          ...(client ? { client } : {}),
          ...(fallback ? { fallback } : {}),
          ...(error ? { error } : {}),
        },
      ];
    }),
  );
  const rowsWritten = lines.some((line) => line.rows === null)
    ? null
    : lines.reduce((sum, line) => sum + (line.rows ?? 0), 0);
  // The day the digest, else the summaries, actually read; else the start's.
  const dayFrom = (step: RunStep) =>
    lines.filter((line) => line.step === step && line.day).at(-1)?.day;
  return dailyRunFinishSchema.parse({
    id: pointer.id,
    startedAt: pointer.startedAt,
    targetDay: dayFrom("digest") ?? dayFrom("summaries") ?? pointer.targetDay,
    finishedAt: now(deps).toISOString(),
    steps,
    rowsWritten,
  });
}

/**
 * Records a step command's outcome; a ledger problem never fails the command.
 * `resolve` returns the endpoint-resolved config, read only when needed.
 */
export async function noteStep(
  deps: LedgerDeps & { flow?: { warn?: (message: string) => void } },
  resolve: () => Promise<{ instance: { publicUrl?: string } }>,
  args: readonly string[],
  result: CommandOutcome,
) {
  if (!stepFor(args)) return;
  try {
    await recordStep(deps, runEndpoint(await resolve()), args, result);
  } catch (error) {
    deps.flow?.warn?.(
      "Could not record the step for the daily report: " +
        (error instanceof Error ? error.message : String(error)),
    );
  }
}

/** After the report is stored, the run no longer collects steps. */
export async function finishRun(deps: LedgerDeps, endpoint: string) {
  const { folder, pointer } = await currentRun(deps, endpoint);
  if (!pointer) return;
  await rm(path.join(folder, `run-${pointer.id}.jsonl`), { force: true });
  await rm(path.join(folder, pointerFile), { force: true });
}
