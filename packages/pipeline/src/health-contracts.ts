import { pruneStatusSchema } from "./retention-contracts";
import { budgetSafetyFields } from "./budget";
import { clientSchema } from "@litscout/core/agent-config";
import { z } from "zod";
import { runtimeSchema, serverStatusSchema } from "./server-contracts";

const count = z.number().int().nonnegative();
const day = z.iso.date();
const timestamp = z.iso.datetime({ precision: 3 });
export const dailyRunPath = "/ingest/daily-run";
export const healthPath = "/operations/health";
export const cutoverWeekdays = 5;
/** Run ids the legacy import gives the old pipeline's runs. */
export const legacyRunPrefix = "run_legacy_";
export const dailyRunPruneLimit = 32;
export const dailyRunReservation = 4 * (dailyRunPruneLimit + 1);
const identity = {
  id: z.uuid(),
  startedAt: timestamp,
  targetDay: day,
};
const step = z.strictObject({
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
});
const steps = z.strictObject({
  fetch: step,
  summaries: step,
  digest: step,
  sync: step,
  legacy: step,
});
export const dailyRunStartSchema = z.strictObject(identity);
export const dailyRunFinishSchema = z
  .strictObject({
    ...identity,
    finishedAt: timestamp,
    steps,
    rowsWritten: count.nullable(),
  })
  .refine((run) => run.finishedAt >= run.startedAt, {
    path: ["finishedAt"],
    message: "Finish time must be on or after start time",
  });
export const dailyRunInputSchema = z.union([
  dailyRunStartSchema,
  dailyRunFinishSchema,
]);
export const dailyRunViewSchema = z.strictObject({
  ...identity,
  finishedAt: timestamp.nullable(),
  steps: steps.nullable(),
  rowsWritten: count.nullable(),
});
export const cutoverRunEvidenceSchema = z
  .strictObject({
    hasRuns: z.boolean(),
    runs: z
      .array(
        z.strictObject({
          day,
          run: dailyRunViewSchema,
          digestAt: timestamp.nullable(),
        }),
      )
      .max(cutoverWeekdays),
  })
  .refine(({ hasRuns, runs }) => hasRuns || runs.length === 0);
export const healthStatusSchema = z.enum([
  "on-time",
  "late",
  "missed",
  "no-listing",
  // Before LitScout's first daily run: the old pipeline's days, not misses.
  "before-start",
  // The old pipeline's digest, brought in by the legacy import.
  "imported",
]);
export const healthSchema = z.strictObject({
  timezone: z.string(),
  onTimeBy: z.string(),
  runtime: runtimeSchema.default("cloudflare"),
  /** The own server's newest report; null on Cloudflare or before one. */
  server: serverStatusSchema.nullable().default(null),
  /** Local day of the earliest recorded daily run; null before any run. */
  firstRunDay: day.nullable().default(null),
  days: z
    .array(
      z.strictObject({
        day,
        status: healthStatusSchema,
        reported: z.boolean(),
        digestAt: z.iso.datetime().nullable(),
      }),
    )
    .length(30),
  runs: z.array(dailyRunViewSchema).max(12),
  budget: z.strictObject({
    ...budgetSafetyFields,
    used: count,
    reserved: count,
    limit: count,
    resetAt: z.iso.datetime(),
    rowsRead: count.nullable(),
  }),
  storage: z.strictObject({
    sizeBytes: count.nullable(),
    feedItems: count,
    summaries: count,
    vaultNotes: count,
  }),
  pruning: pruneStatusSchema.nullable().optional(),
  links: z.strictObject({ unchecked: count, capped: z.boolean() }),
  mirror: z.strictObject({
    activeAt: z.iso.datetime().nullable(),
    completedAt: z.iso.datetime().nullable(),
  }),
});
export type DailyRunInput = z.output<typeof dailyRunInputSchema>;
export type DailyRunView = z.output<typeof dailyRunViewSchema>;
export type CutoverRunEvidence = z.output<typeof cutoverRunEvidenceSchema>;
export type HealthStatus = z.output<typeof healthStatusSchema>;
