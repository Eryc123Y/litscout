import {
  feedPageSchema,
  listPaperSchema,
  readingStateSchema,
} from "./read-contracts";
import { booleanQuery, venueKindQuery } from "./query-filters";
import { z } from "zod";
import {
  daySchema,
  statusSchema,
  fivePartSchema,
  radarSchema,
} from "./contracts/index";
const counts = z
  .object({
    total: z.number().default(0),
    sources: z.record(z.string(), z.number()).default({}),
    /** Papers on the reader's topics that day. */
    shortlisted: z.number().optional(),
    /** How many of those the signed-in reader has opened. Private only. */
    read: z.number().optional(),
  })
  .default({ total: 0, sources: {} });
export const webDaySchema = z.object({
  day: daySchema,
  status: statusSchema,
  counts,
});
export const webPaperSchema = z.object({
  compact: z.literal(true).optional(),
  firstSeenOn: daySchema.optional(),
  paperId: z.string(),
  title: z.string(),
  abstract: z.string().nullable(),
  authors: z.array(z.object({ name: z.string() })),
  source: z.string(),
  topics: z.array(z.string()),
  shortlisted: z.boolean(),
  summaries: z.array(
    z.object({ lang: z.enum(["en", "zh"]), content: fivePartSchema }),
  ),
  identifiers: z.array(z.object({ scheme: z.string(), value: z.string() })),
  links: z.array(
    z.object({
      kind: z.string(),
      url: z.string(),
      checkedAt: z.string().nullable().optional(),
      httpStatus: z.number().nullable().optional(),
      oaStatus: z.string().optional(),
    }),
  ),
  venue: z.string().nullable().default(null),
  venueKind: z.string().default("preprint"),
  year: z.number().nullable().default(null),
  publishedOn: daySchema.nullable().default(null),
  categories: z.array(z.string()).default([]),
  hfUpvotes: z.number().nullable().default(null),
});
export const privateWebPaperSchema = webPaperSchema.extend({
  verified: z.boolean().optional(),
  readingState: readingStateSchema.optional(),
});
export const webListPaperSchema = listPaperSchema.omit({ readingState: true });
export const webFeedSchema = feedPageSchema.extend({
  items: z.array(webListPaperSchema).max(100),
});
export const privateWebFeedSchema = feedPageSchema;
export const webDaysSchema = z.array(webDaySchema);
export const instanceSchema = z.object({
  name: z.string().default("LitScout"),
  publicFeed: z.boolean().default(false),
  language: z.enum(["en", "zh"]).default("en"),
  timezone: z.string().default("UTC"),
  topics: z.array(z.string()).default([]),
  keywordOnly: z.boolean().optional(),
  /** Venues the owner marks as top in the watchlist, for the Top filter. */
  topVenues: z.array(z.string().max(300)).max(500).optional(),
});
/** Why a paper is in the day's triage queue, strongest reason first. */
export const triageReason = z.enum(["radar", "pick", "code"]);
export const triageQueueSchema = z.object({
  day: daySchema,
  items: z.array(listPaperSchema.extend({ reason: triageReason })).max(200),
  /** How many papers wait in the library's To read section, on any day. */
  toRead: z.number(),
});
export type TriageQueue = z.infer<typeof triageQueueSchema>;
export type TriageRow = TriageQueue["items"][number];
export type WebPaper = z.infer<typeof privateWebPaperSchema>;
export type WebFeed = z.infer<typeof privateWebFeedSchema>;
export type WebDay = z.infer<typeof webDaySchema>;
export type InstanceInfo = z.infer<typeof instanceSchema>;

export const webDayPageSchema = z.object({
  items: webDaysSchema.max(100),
  nextBefore: daySchema.nullable(),
});
export const webCountsSchema = z.object({
  day: daySchema,
  status: statusSchema,
  counts: feedPageSchema.shape.counts,
});
export const digestReferenceSchema = z.object({
  paperId: z.string().startsWith("pap_").max(128),
  source: z.string().min(1).max(5000).nullable(),
  day: daySchema.nullable(),
  /** Sent with the digest so the reader can name its papers at once. */
  title: z.string().optional(),
  topics: z.array(z.string()).optional(),
});
export const digestRowsQuerySchema = z.object({
  ids: z
    .string()
    .max(64000)
    .transform((value, ctx) => {
      try {
        return JSON.parse(value) as unknown;
      } catch {
        ctx.addIssue({ code: "custom", message: "Invalid references" });
        return z.NEVER;
      }
    })
    .pipe(
      z
        .array(
          digestReferenceSchema.extend({ source: z.string().min(1).max(5000) }),
        )
        .min(1)
        .max(50),
    ),
});
export const digestRowsSchema = z.object({
  items: z
    .array(
      digestReferenceSchema.extend({
        source: z.string(),
        title: z.string(),
        topics: z.array(z.string()),
      }),
    )
    .max(50),
});
export type DigestReference = z.infer<typeof digestReferenceSchema>;
export type DigestRow = z.infer<typeof digestRowsSchema>["items"][number];

export const webDigestSchema = z
  .object({
    bodyMd: z.string(),
    createdAt: z.iso.datetime().optional(),
    lang: z.enum(["en", "zh"]),
    final: z.boolean(),
    picks: z.array(digestReferenceSchema).default([]),
    radar: z
      .array(
        radarSchema
          .strip()
          .omit({ day: true })
          .extend(digestReferenceSchema.shape),
      )
      .default([]),
  })
  .nullable();

/** Paper search across every day, for the search box on every page. */
export const paperSearchQuery = z.object({
  q: z.string().trim().min(3).max(200),
  limit: z.coerce.number().int().min(1).max(20).default(12),
  /** The day pages' venue filters. */
  kind: venueKindQuery.optional(),
  top: booleanQuery,
});
export const paperSearchSchema = z.object({
  items: z
    .array(
      z.object({
        paperId: z.string(),
        title: z.string(),
        authors: z.array(z.object({ name: z.string() })).max(4),
        authorCount: z.number(),
        /** The latest day the paper was listed, and under which source. */
        day: daySchema.nullable(),
        source: z.string().nullable(),
        venue: z.string().nullable(),
      }),
    )
    .max(20),
});
export type PaperSearchHit = z.infer<typeof paperSearchSchema>["items"][number];
