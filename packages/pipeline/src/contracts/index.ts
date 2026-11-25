import { suggestedIdea, suggestionLimit } from "../research-contracts";
import { vaultHash, vaultPath } from "../vault-contracts";
import { z } from "zod";
import { normalizeDoi } from "@litscout/core/normalize";
import { invalidRecordSchema, chunkReportSchema } from "../records";
import { boundedJson, httpUrlSchema, cursorValueSchema } from "./limits";
import { clientSchema } from "@litscout/core/agent-config";
const agentReport = {
  clientsUsed: z
    .array(clientSchema)
    .max(clientSchema.options.length)
    .default([]),
  fallback: z
    .array(
      z.strictObject({
        from: clientSchema,
        to: clientSchema,
        reason: z.string().max(128),
      }),
    )
    .max(clientSchema.options.length - 1)
    .default([]),
  preflight: z
    .array(
      z.strictObject({
        client: clientSchema,
        usable: z.boolean(),
        reason: z.string().max(128),
      }),
    )
    .max(clientSchema.options.length)
    .default([]),
};
const ingestReport = z
  .strictObject({
    requests: z
      .array(
        z.strictObject({
          path: z.string().max(128),
          items: z.number().int().nonnegative(),
          bytes: z.number().int().nonnegative(),
        }),
      )
      .max(100000),
    retries: z.number().int().nonnegative(),
    failures: z
      .array(
        z.strictObject({
          path: z.string().max(128),
          id: z.string().max(1000),
          reason: z.string().max(1000),
        }),
      )
      .max(100000),
  })
  .optional();
export const daySchema = z.iso.date().max(10);
export const langSchema = z.enum(["en", "zh"]);
export const statusSchema = z.enum([
  "pending",
  "crawled",
  "summarised",
  "digested",
  "final",
  "empty",
]);
export const dayReopenPlanSchema = z.object({
  day: daySchema,
  dryRun: z.boolean(),
  changed: z.boolean(),
  oldStatus: statusSchema.nullable(),
  newStatus: statusSchema.nullable(),
  digests: z.array(z.object({ lang: z.string() })),
});
const text = z.string().max(5000).trim().min(1);
export const fivePartSchema = z.strictObject({
  tldr: text,
  motivation: text,
  method: text,
  result: text,
  conclusion: text,
});
export const identifierSchema = z
  .strictObject({
    scheme: z.enum([
      "doi",
      "arxiv",
      "openalex",
      "s2",
      "openreview",
      "acl",
      "pmlr",
      "jmlr",
      "pmid",
      "dblp",
      "url",
    ]),
    value: text,
  })
  .refine(
    (value) =>
      value.scheme !== "doi" || normalizeDoi(value.value) !== undefined,
    { path: ["value"], message: "Invalid DOI identifier" },
  );
export const linkSchema = z.strictObject({
  kind: z.enum([
    "doi",
    "landing",
    "pdf_oa",
    "pdf_arxiv",
    "html",
    "code",
    "project",
    "alphaxiv",
  ]),
  url: httpUrlSchema,
  licence: z.string().max(5000).nullable().default(null),
  oaStatus: z
    .enum(["gold", "green", "hybrid", "bronze", "closed", "unknown"])
    .default("unknown"),
});
export const paperSchema = z.strictObject({
  key: text,
  title: text.max(1000),
  abstract: z.string().max(20000).nullable().default(null),
  authors: z.array(z.string().max(5000)).max(500).default([]),
  venue: z.string().max(5000).nullable().default(null),
  venueKind: z
    .enum(["preprint", "journal", "conference", "workshop"])
    .default("preprint"),
  year: z.number().int().nullable().default(null),
  publishedOn: daySchema.nullable().default(null),
  categories: z.array(z.string().max(5000)).max(20).default([]),
  source: text,
  identifiers: z.array(identifierSchema).max(20).min(1),
  links: z.array(linkSchema).max(20).default([]),
  topics: z.array(z.string().max(5000)).max(50).default([]),
  shortlisted: z.boolean().default(false),
  rankInSource: z.number().int().nonnegative().nullable().default(null),
  hfUpvotes: z.number().int().nonnegative().nullable().default(null),
});
export const summarySchema = z.strictObject({
  paperId: z.string().max(5000).startsWith("pap_"),
  lang: langSchema.default("en"),
  content: fivePartSchema,
  model: z.string().max(5000).nullable().default(null),
  client: z.string().max(5000).nullable().default(null),
});
export const radarSchema = z.strictObject({
  day: daySchema,
  paperId: text,
  projectId: z.string().max(5000).nullable().default(null),
  project: z.string().trim().min(1).max(5000).optional(),
  level: z.enum(["high", "medium", "borrow"]),
  fullTextRead: z.boolean().default(false),
  /** What the paper shows, with its evidence grade. */
  reason: text,
  /** Why it bears on this project now. */
  relevance: z.string().max(5000).default(""),
  /** Up to three different ways it could help: a method, an experiment, a limit to test, a framing. */
  angles: z.array(z.string().trim().min(1).max(600)).max(3).default([]),
  action: z.string().max(5000).default(""),
  lookBack: z.boolean().default(false),
});
export const pickSchema = z.strictObject({ paperId: text, gist: text });
export const digestSchema = z
  .strictObject({
    day: daySchema,
    lang: langSchema.default("en"),
    topics: z
      .record(z.string().max(5000), z.array(pickSchema).max(3))
      .default({}),
    radar: z
      .array(radarSchema.omit({ day: true }))
      .max(3)
      .default([]),
    other: z.array(pickSchema).max(2).default([]),
    journal: z.array(pickSchema).max(2).default([]),
    note: z.string().max(5000).default(""),
    reportText: z.string().max(5000).default(""),
    suggestions: z.array(suggestedIdea).max(suggestionLimit).optional(),
    final: z.boolean().default(false),
  })
  .superRefine((v, ctx) => {
    for (const [index, item] of v.radar.entries())
      if (item.level !== "borrow" && !item.fullTextRead)
        ctx.addIssue({
          code: "custom",
          path: ["radar", index, "fullTextRead"],
          message: "High and medium grades require full text",
        });
  });
/** A stored digest's Markdown: a day's brief, or a week of them. */
const digestBody = z.string().trim().min(1).max(200000);
export const digestRecordSchema = z.strictObject({
  day: daySchema,
  lang: langSchema.default("en"),
  kind: z.enum(["daily", "weekly"]).default("daily"),
  bodyMd: digestBody,
  picks: z.array(z.string().max(5000)).max(1000).default([]),
  radar: z
    .array(radarSchema.omit({ day: true }))
    .max(10000)
    .default([]),
  final: z.boolean().default(false),
  suggestions: z.array(suggestedIdea).max(suggestionLimit).optional(),
});
export const feedDaySchema = z.strictObject({
  day: daySchema,
  status: statusSchema,
  counts: z
    .record(z.string().max(5000), z.number().int().nonnegative())
    .default({}),
  crawledAt: z.iso.datetime().max(35).nullable().default(null),
});
export const feedItemSchema = z
  .object({
    paperId: text,
    title: text,
    abstract: z.string().max(20000).nullable(),
    authors: z.array(z.object({ name: z.string().max(5000) })).max(500),
    source: text,
    topics: z.array(z.string().max(5000)).max(50),
    shortlisted: z.boolean(),
    summaries: z
      .array(
        summarySchema.extend({
          kind: z.string().max(5000).optional(),
          createdAt: z.string().max(5000).optional(),
          rev: z.number().optional(),
        }),
      )
      .max(10000),
    identifiers: z.array(identifierSchema).max(20),
    links: z
      .array(
        linkSchema.extend({
          id: z.string().max(5000).optional(),
          paperId: z.string().max(5000).optional(),
          source: z.string().max(5000).optional(),
          checkedAt: z.string().max(5000).nullable().optional(),
          httpStatus: z.number().nullable().optional(),
        }),
      )
      .max(20),
  })
  .catchall(boundedJson);
export const runSchema = z.strictObject({
  id: text,
  kind: z.enum([
    "crawl",
    "upload",
    "summaries",
    "digest",
    "weekly",
    "legacy_import",
  ]),
  day: daySchema,
  status: text,
  startedAt: z.iso.datetime().max(35),
  finishedAt: z.iso.datetime().max(35).nullable().default(null),
  stats: z.record(z.string().max(5000), boundedJson).default({}),
  error: z.string().max(5000).nullable().default(null),
});
export const cursorSchema = cursorValueSchema;
export const missedSchema = z.strictObject({
  id: text,
  paperId: text,
  foundOn: daySchema,
  where: text,
  note: z.string().max(5000).default(""),
});
export const ratingSchema = z.strictObject({
  id: text,
  paperId: text,
  day: daySchema,
  kind: z.enum(["rate_up", "rate_down", "rate_clear"]),
  source: text,
  at: z.iso.datetime().max(35),
});
export const fulltextSchema = z.strictObject({
  paperId: text,
  text: z.string().max(60000).nullable(),
  reason: z.string().max(5000).optional(),
});
/** Owner brief text is local agent input, never a Worker upload contract. */
export const localBriefSchema = z.strictObject({
  path: text,
  body: z.string().max(200000),
});
export const schemas = {
  invalidRecord: invalidRecordSchema,
  batchReport: z.object({
    accepted: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    invalid: z.array(invalidRecordSchema).max(1000),
  }),
  paperBatch: z.strictObject({
    day: daySchema,
    papers: z.array(z.unknown()).max(100),
    legacy: z.enum(["import", "plan"]).optional(),
    maxRows: z.number().int().nonnegative().optional(),
  }),
  summaryBatch: z.strictObject({
    day: daySchema.nullable().optional(),
    summaries: z.array(z.unknown()).max(100),
    legacy: z.literal(true).optional(),
    maxRows: z.number().int().nonnegative().optional(),
  }),
  radarBatch: z.strictObject({ radar: z.array(z.unknown()).max(100) }),
  legacyBatch: z.strictObject({
    cursors: z.array(z.unknown()).max(100).default([]),
    runs: z.array(z.unknown()).max(100).default([]),
    missed: z.array(z.unknown()).max(100).default([]),
    ratings: z.array(z.unknown()).max(100).default([]),
  }),
  fivePart: fivePartSchema,
  usage: z.strictObject({
    fiveHour: z.number().min(0).max(100),
    weekly: z.number().min(0).max(100),
  }),
  summaryRun: z.object({
    ...agentReport,
    ingest: ingestReport,
    quarantined: z.array(z.number().int().nonnegative()).max(10000).default([]),
    ran: z.number().int().nonnegative(),
    failures: z.array(z.string().max(5000)).max(10000),
    stopped: z.string().max(5000).nullable(),
    status: z.string().max(5000).optional(),
    message: z.string().max(5000).optional(),
  }),
  fetchReport: z.object({
    ingest: ingestReport,
    skipped: z.number().int().nonnegative().default(0),
    invalid: z.array(invalidRecordSchema).max(10000).default([]),
    chunks: z.array(chunkReportSchema).max(10000).default([]),
    diagnostics: z
      .array(
        z.strictObject({
          source: z.string().max(64),
          name: z.string().max(128),
          message: z.string().max(2000),
          stack: z.string().max(5000),
        }),
      )
      .max(1000)
      .default([]),
    message: z.string().max(5000).optional(),
    day: daySchema,
    status: z.enum(["exists", "pending", "crawled"]),
    added: z.number().int().nonnegative(),
    arxivAdded: z.number().int().nonnegative().optional(),
    venuesAdded: z.number().int().nonnegative().optional(),
    venueOnlyDays: z.array(daySchema).max(10000).optional(),
    gaps: z.array(daySchema).max(10000),
    deferred: z.number().int().nonnegative().optional(),
    deferredExplanation: z.string().max(1000).optional(),
    noAnnouncement: z.array(daySchema).max(60).default([]),
    gained: z.number().int().nonnegative().optional(),
    signalsUpdated: z.number().int().nonnegative().optional(),
    warnings: z.array(z.string().max(5000)).max(10000).optional(),
  }),
  budgetShort: z.strictObject({
    ingest: ingestReport,
    status: z.literal("budget-short"),
    day: daySchema,
    added: z.literal(0),
    gaps: z.array(daySchema).max(10000),
    requiredRows: z.number().int().positive(),
    availableRows: z.number().int().nonnegative(),
    shortfall: z.number().int().positive(),
    resumeAt: z.iso.datetime().max(35),
    message: text,
  }),
  fulltext: fulltextSchema,
  budgetStop: z.strictObject({
    ingest: ingestReport,
    status: z.literal("budget-stop"),
    resumeAt: z.iso.datetime().max(35),
    message: text,
  }),
  legacyReport: z.strictObject({
    ingest: ingestReport,
    invalid: z.array(invalidRecordSchema).max(10000).default([]),
    chunks: z.array(chunkReportSchema).max(10000).default([]),
    status: z.enum(["dry-run", "done", "max-rows"]),
    completedOperations: z.number().int().nonnegative().optional(),
    rowsBudgeted: z.number().int().nonnegative().optional(),
    rowsUsed: z.number().int().nonnegative().optional(),
    daysImported: z.array(daySchema).max(10000).optional(),
    daysLeft: z.array(daySchema).max(10000).optional(),
    projectedFinishDate: daySchema.nullable().optional(),
    counts: z
      .array(
        z.strictObject({
          day: daySchema,
          papers: z.number().int().nonnegative(),
          summaries: z.number().int().nonnegative(),
          skipped: z.number().int().nonnegative().default(0),
        }),
      )
      .max(10000),
    estimatedRows: z.number().int().nonnegative(),
    operations: z.number().int().nonnegative(),
    warnings: z.array(z.string().max(5000)).max(10000),
  }),
  papers: z.strictObject({
    day: daySchema,
    papers: z.array(paperSchema).max(100),
  }),
  summaries: z.strictObject({ summaries: z.array(summarySchema).max(100) }),
  feedDay: feedDaySchema,
  digestDraft: digestSchema,
  digest: digestRecordSchema,
  radar: z.strictObject({ radar: z.array(radarSchema).max(100) }),
  cursor: cursorSchema,
  run: runSchema,
  legacy: z.strictObject({
    cursors: z.array(cursorSchema).max(100).default([]),
    runs: z.array(runSchema).max(100).default([]),
    missed: z.array(missedSchema).max(100).default([]),
    ratings: z.array(ratingSchema).max(100).default([]),
  }),
  feed: z.object({
    day: daySchema,
    status: statusSchema,
    counts: z.record(z.string().max(5000), z.number()),
    items: z.array(feedItemSchema).max(10000),
  }),
  todo: z.strictObject({
    day: daySchema,
    lang: langSchema,
    chunks: z
      .array(
        z
          .array(z.strictObject({ paperId: text, title: text, abstract: text }))
          .max(100),
      )
      .max(1000),
    noAbstract: z.number().int().nonnegative(),
  }),
  context: z.object({
    day: daySchema,
    lang: langSchema,
    candidates: z.array(feedItemSchema).max(10000),
    topicCandidates: z
      .array(
        z.object({
          name: text,
          keywords: z.array(text).max(10000),
          paperIds: z.array(text).max(10000),
        }),
      )
      .max(10000)
      .default([]),
    all: z
      .array(
        z.object({ paperId: text, title: text, tldr: z.string().max(5000) }),
      )
      .max(10000),
    briefs: z.array(localBriefSchema).max(20),
    openIdeas: z
      .array(
        z.object({
          id: vaultHash,
          title: z.string().max(512),
          description: z.string().max(1500).nullable(),
          status: z.enum(["seed", "exploring"]),
          project: z.string().max(1500).nullable().optional(),
          path: vaultPath,
          body: z.string().max(120000).optional(),
        }),
      )
      .max(100)
      .optional(),
    vaultProjects: z
      .array(
        z.object({
          id: vaultHash,
          title: z.string().max(512),
          description: z.string().max(1500).nullable().optional(),
          status: z.string().max(1500).nullable().optional(),
          path: vaultPath,
          body: z.string().max(120000).optional(),
        }),
      )
      .max(50)
      .optional(),
    ratings: z.array(ratingSchema).max(10000),
    radar: z.array(feedItemSchema).max(10000),
    fulltext: fulltextSchema.optional(),
  }),
  weekly: z.strictObject({
    day: daySchema,
    // The week's daily briefs in full, as stored (about 15,000 characters each).
    bodyMd: digestBody,
    missed: z.array(missedSchema).max(10000),
    lookBack: z.array(feedItemSchema).max(3),
    direction: z.number().int().min(1).max(5),
  }),
  status: z
    .array(
      z.strictObject({
        day: daySchema,
        status: statusSchema.or(z.literal("closed-early")),
        suggestion: z.string().max(64).optional(),
        target: z.literal(true).optional(),
        /** Crawled, older than the target and never digested: a skipped day. */
        behind: z.literal(true).optional(),
        crawled: z.boolean(),
        summarised: z.boolean(),
        digested: z.boolean(),
        final: z.boolean(),
      }),
    )
    .max(10000),
};
export function contracts(): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(schemas).map(([name, schema]) => [
      name,
      z.toJSONSchema(schema, { io: "input" }),
    ]),
  );
}
export type PaperInput = z.output<typeof paperSchema>;
export type FeedItem = z.output<typeof feedItemSchema>;
export type DigestDraft = z.output<typeof digestSchema>;
