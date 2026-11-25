import { z } from "zod";

export const prunePath = "/ingest/prune";
export const pruneOverhead = 12;
export const retentionPageSize = 10;
export const retentionReasons = [
  "library",
  "reading",
  "digest",
  "research",
  "recent",
] as const;
export const pruneCursorSchema = z.strictObject({
  age: z.iso.date(),
  id: z.string().min(1).max(128),
});
const count = z.number().int().nonnegative();
const previewRow = z.strictObject({
  title: z.string(),
  bound: count,
  reasons: z.array(z.enum(retentionReasons)),
  eligible: z.boolean(),
});
export const pruneResultSchema = z.strictObject({
  enabled: z.boolean(),
  rows: z.array(previewRow),
  next: pruneCursorSchema.nullable(),
  available: count,
  sizeBytes: count.nullable(),
  papersPruned: count,
  rowsWritten: count,
  waiting: count,
});
/** Compact rows that expire (`storage.compactMonths` after their last
 * listing, or earlier over the storage cap), with their feed occurrences. */
export const expirePath = "/ingest/expire";
export const expiryPageSize = 100;
export const expiryInputSchema = z.strictObject({
  /** The server is over its storage cap: expire up to a week past the
   * oldest compact row, never into the window of full records. */
  overCap: z.boolean().optional(),
  /** Never expire past this day: a run's later pages keep its first horizon. */
  notAfter: z.iso.date().optional(),
});
export const expiryPreviewSchema = z.strictObject({
  enabled: z.boolean(),
  before: z.iso.date(),
  count,
  oldestDay: z.iso.date().nullable(),
  sample: z.array(z.string()).max(10),
});
export const expiryResultSchema = z.strictObject({
  enabled: z.boolean(),
  before: z.iso.date(),
  expired: count,
  rowsWritten: count,
  /** Rows of this page left for lack of budget. */
  waiting: count,
  /** The page was full, so more may be due. */
  more: z.boolean(),
});
export const pruneStatusSchema = z.strictObject({
  lastAt: z.iso.datetime(),
  papersPruned: count,
  rowsUsed: count,
  waiting: count.nullable(),
});
