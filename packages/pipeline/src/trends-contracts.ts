import { z } from "zod";
import { daySchema } from "./contracts/index";

export const trendsPath = "/trends";
export const trendsUploadPath = "/ingest/trends";
export const trendsSourcePath = trendsUploadPath + "/source";
export const trendsBatchSize = 10;
export const trendsPaperPageSize = 20;
export const trendsUploadBytes = 128 * 1024;

export const trendMonth = z
  .string()
  .regex(/^(?!0000|9999)\d{4}-(?:0[1-9]|1[0-2])$/, "Use YYYY-MM");
const topicName = z.string().min(1).max(5000);
const paperId = z.string().min(1).max(5000);
const count = z.number().int().nonnegative();
const offset = z.coerce.number().int().min(0).max(1_000_000).optional();

export const trendsQuery = z.object({
  topic: topicName.optional(),
  month: trendMonth.optional(),
  pickOffset: offset,
  activityOffset: offset,
});
export type TrendsQuery = z.output<typeof trendsQuery>;

export const trendLevel = z.enum(["high", "medium", "borrow"]);
const gradeCounts = z.object({ high: count, medium: count, borrow: count });
const term = z
  .string()
  .min(3)
  .max(32)
  .regex(/^\p{L}[\p{L}\p{N}]+$/u);
const trendTerm = z.object({ term, count, score: z.number().nonnegative() });
const trendRating = z.enum(["up", "down"]).nullable();
export const trendActivity = z.object({
  paperId,
  saved: z.boolean(),
  rating: trendRating,
});
const trendCounts = z.object({
  month: trendMonth,
  volume: count,
  shortlisted: count,
  radar: gradeCounts,
});
/** Rising terms compare with last month; fewer listing days than this is too
 * thin a baseline to show them. */
export const risingMinimumDays = 5;
/** The listing days of last month that rising terms were compared with. */
export const trendComparison = z
  .strictObject({
    days: count.max(31),
    first: daySchema.nullable(),
    last: daySchema.nullable(),
  })
  .refine(
    ({ days, first, last }) =>
      days === 0
        ? first === null && last === null
        : first !== null && last !== null && first <= last,
    "Comparison days and range disagree",
  );
export type TrendComparison = z.output<typeof trendComparison>;
const trendTerms = z.object({
  recurring: z.array(trendTerm).max(15),
  rising: z.array(trendTerm).max(15),
  // Absent on rows written before the comparison was recorded.
  comparison: trendComparison.optional(),
});
export const trendRow = z
  .strictObject({
    ...trendCounts.shape,
    ...trendTerms.shape,
    topic: topicName,
    picks: z.array(paperId),
    activity: z.array(trendActivity),
  })
  .refine((row) => row.shortlisted <= row.volume, "Shortlist exceeds volume");
export type TrendRow = z.output<typeof trendRow>;

export const trendsUpload = z
  .strictObject({ rows: z.array(trendRow).min(1).max(trendsBatchSize) })
  .refine(
    ({ rows }) => new Set(rows.map(({ topic }) => topic)).size === rows.length,
    "A refresh batch must contain unique topics",
  )
  .refine(
    ({ rows }) => rows.every(({ month }) => month === rows[0]!.month),
    "A refresh batch must cover one month",
  );

const titledPaper = z.object({ paperId, title: z.string().nullable() });
export const trendsResponse = z.object({
  topic: topicName.nullable(),
  month: trendMonth,
  currentMonth: trendMonth,
  history: z
    .array(
      z.object({
        month: trendMonth,
        volume: count,
        picks: count,
        radarHits: count,
      }),
    )
    .max(12),
  detail: z
    .object({
      ...trendCounts.shape,
      ...trendTerms.shape,
      pickCount: count,
      saveCount: count,
      ratingCount: count,
      picks: z.array(titledPaper),
      activity: z.array(
        trendActivity.extend({ title: titledPaper.shape.title }),
      ),
      nextPickOffset: count.nullable(),
      nextActivityOffset: count.nullable(),
    })
    .nullable(),
});
export type TrendsResponse = z.output<typeof trendsResponse>;

export function shiftMonth(month: string, distance: number) {
  const [year, number] = month.split("-").map(Number) as [number, number];
  const shifted = year * 12 + number - 1 + distance;
  return `${String(Math.floor(shifted / 12)).padStart(4, "0")}-${String((((shifted % 12) + 12) % 12) + 1).padStart(2, "0")}`;
}

export const trendPaper = z.object({
  paperId,
  /** The listing day, on feed source pages; references have none. */
  day: daySchema.optional(),
  title: z.string(),
  abstract: z.string().nullable(),
  topics: z.array(topicName),
  shortlisted: z.boolean(),
});
export type TrendPaper = z.output<typeof trendPaper>;
export const trendRadar = z.object({ paperId, level: trendLevel });
export const trendEvent = z.object({
  paperId,
  kind: z.enum(["save", "rate_up", "rate_down", "rate_clear"]),
});
export const trendDigest = z.object({
  picks: z.array(paperId),
  radar: z.array(trendRadar),
});
export const trendSourceKinds = z.enum([
  "papers",
  "digests",
  "radar",
  "events",
]);
const cursor = z.string().max(12000).optional();
export const trendSourceQuery = z.object({
  month: trendMonth,
  kind: trendSourceKinds,
  cursor,
});
export type TrendSourceQuery = z.output<typeof trendSourceQuery>;
export const trendSearchQuery = z.object({
  month: trendMonth,
  topic: topicName,
  term,
  cursor,
});
export type TrendSearchQuery = z.output<typeof trendSearchQuery>;
export const feedTrendCursor = z.tuple([
  daySchema,
  paperId,
  z.string().min(1).max(5000),
]);
export const datedTrendCursor = z.tuple([
  daySchema,
  z.number().int().positive(),
]);

export function trendPage<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: cursor.unwrap().nullable(),
  });
}
export const trendSearchResponse = trendPage(
  titledPaper.extend({ title: z.string() }),
);
export const trendWindow = z.object({ oldestMonth: trendMonth.nullable() });
export const trendReferencesQuery = z.object({
  ids: z
    .string()
    .transform((raw, ctx) => {
      try {
        return JSON.parse(raw) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid paper IDs" });
        return z.NEVER;
      }
    })
    .pipe(z.array(paperId).min(1).max(20)),
});
