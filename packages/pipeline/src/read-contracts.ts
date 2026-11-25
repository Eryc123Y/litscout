import { z } from "zod";
import {
  daySchema,
  statusSchema,
  langSchema,
  feedItemSchema,
  identifierSchema,
} from "./contracts/index";
import { booleanQuery, venueKindQuery } from "./query-filters";
import { libraryStatus } from "./library-contracts";

export const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(64000).optional(),
});
export const feedQuerySchema = pageQuerySchema.extend({
  topic: z.string().max(5000).optional(),
  source: z.string().max(5000).optional(),
  shortlisted: booleanQuery,
  unread: booleanQuery,
  venue: z.string().max(5000).optional(),
  /** Venue type: arXiv and other preprints, conference or journal papers. */
  kind: venueKindQuery.optional(),
  /** Only papers from the instance's top venues. */
  top: booleanQuery,
  /** Only papers with a public code link. */
  code: booleanQuery,
  /** The signed-in reader's decision: "open" leaves out skipped papers,
   * "saved" is any library entry that is not waiting in To read. */
  decision: z.enum(["open", "to_read", "saved", "skipped"]).optional(),
  q: z
    .string()
    .trim()
    .max(1000)
    .refine((v) => Array.from(v).length >= 3, "Enter at least three characters")
    .optional(),
});
export const todoQuerySchema = pageQuerySchema.extend({
  lang: langSchema.default("en"),
});
export const dayCountsSchema = z.object({
  total: z.number(),
  summarised: z.number(),
  shortlisted: z.number(),
  arxiv: z.number(),
  venues: z.number(),
  topics: z.record(z.string(), z.number()),
  sources: z.record(z.string(), z.number()),
  venueCounts: z.record(z.string(), z.number()),
});
export const readingStateSchema = z.object({
  readAt: z.string().nullable(),
  /** On list rows: when the reader skipped the paper. */
  skippedAt: z.string().nullable().optional(),
  /** On list rows: the library entry's status, null when not in the library. */
  library: libraryStatus.nullable().optional(),
});
/** How many authors a list row carries. A reader with the row alone can
 * then name the authors of nearly every paper in full. */
export const listAuthorsMax = 12;
export const listPaperSchema = z.object({
  abstract: z.string().nullable().optional(),
  /** False when the stored paper has no abstract, so no summary will come. */
  hasAbstract: z.boolean().optional(),
  paperId: z.string(),
  title: z.string(),
  /** The first authors, up to twelve; authorCount has the full number. */
  authors: z.array(z.object({ name: z.string() })).max(listAuthorsMax),
  authorCount: z.number(),
  topics: z.array(z.string()),
  identifiers: z.array(z.object({ scheme: z.string(), value: z.string() })),
  /** The paper's saved links, kind and address only: with the identifiers
   * they are enough to draw a paper's link buttons before its record. */
  links: z.array(z.object({ kind: z.string(), url: z.string() })).optional(),
  venue: z.string().nullable(),
  venueKind: z.string(),
  source: z.string(),
  year: z.number().nullable(),
  publishedOn: daySchema.nullable(),
  categories: z.array(z.string()),
  hfUpvotes: z.number().nullable(),
  shortlisted: z.boolean(),
  tldr: z.array(z.object({ lang: langSchema, text: z.string() })),
  readingState: readingStateSchema.optional(),
});
export const feedPageSchema = z.object({
  day: daySchema,
  status: statusSchema,
  counts: dayCountsSchema,
  items: z.array(listPaperSchema).max(100),
  nextCursor: z.string().nullable(),
});
export const todoPageSchema = feedPageSchema.omit({ items: true }).extend({
  noAbstract: z.number(),
  items: z
    .array(
      z.object({
        paperId: z.string(),
        title: z.string(),
        abstract: z.string(),
      }),
    )
    .max(100),
});
export type ListPaper = z.infer<typeof listPaperSchema>;

export const fullPageQuerySchema = feedQuerySchema.extend({
  ids: z
    .string()
    .max(6500)
    .transform((v) => v.split(","))
    .pipe(z.array(z.string().startsWith("pap_").max(128)).min(1).max(50))
    .optional(),
  limit: z.coerce.number().int().min(1).max(50).default(30),
});
export const paperQuerySchema = z
  .object({
    day: daySchema.optional(),
    source: z.string().min(1).max(5000).optional(),
  })
  .refine((q) => !q.day || Boolean(q.source), {
    message: "A day-scoped paper read requires source",
    path: ["source"],
  });
export const historyQuerySchema = pageQuerySchema
  .extend({
    from: daySchema,
    to: daySchema,
    limit: z.coerce.number().int().min(1).max(200).default(200),
  })
  .refine(
    (q) =>
      q.from <= q.to && Date.parse(q.to) - Date.parse(q.from) <= 60 * 86400000,
    "History range must be within 60 days",
  );
export const historyPaperSchema = listPaperSchema
  // History rows stay slim: no links, and the first four authors.
  .omit({ authorCount: true, tldr: true, readingState: true, links: true })
  .extend({
    identifiers: z.array(identifierSchema).max(20),
    day: daySchema,
    authors: z.array(z.object({ name: z.string() })).max(4),
    rankInSource: z.number().nullable(),
    hasAbstract: z.boolean(),
    compact: z.literal(true).optional(),
  });
export const historyPageSchema = z.object({
  items: z.array(historyPaperSchema).max(200),
  nextCursor: z.string().nullable(),
});
export type HistoryPaper = z.infer<typeof historyPaperSchema>;

export const fullPageSchema = feedPageSchema.extend({
  items: z.array(feedItemSchema).max(50),
});
