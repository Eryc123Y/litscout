import { z } from "zod";
import { mirrorFolderKey, mirrorFolderLabel } from "./alphaxiv-contracts";
import { booleanQuery, venueKindQuery } from "./query-filters";

export const paperIdSchema = z.string().max(5000).regex(/^pap_/);
/** "to_read" is the queue a day's triage fills; "saved" keeps a paper
 * without a promise to read it. */
export const libraryStatus = z.enum([
  "to_read",
  "reading",
  "saved",
  "read",
  "archived",
]);
/** What an add may ask for; the later stages are set by editing the entry. */
export const addStatus = z.enum(["to_read", "saved"]);
export const librarySource = z.enum(["web", "cli", "mcp", "feed"]);
export const ratingSchema = z.enum(["none", "up", "down"]);
export const eventKind = z.enum([
  "open",
  "rate_up",
  "rate_down",
  "rate_clear",
  "star",
  "unstar",
  "save",
  "from_report",
  "skip",
  "unskip",
]);
export const revision = z.object({ if_rev: z.number().int().positive() });
export const paperQuery = z.string().trim().min(1).max(2048);
export const saveInput = z.object({
  query: paperQuery,
  dry_run: z.boolean().default(false),
  source: librarySource.default("web"),
  /** "to_read" queues the paper for reading; left out, it is saved. */
  status: addStatus.optional(),
});
export const libraryQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(7000).optional(),
  q: z.string().trim().min(3).max(200).optional(),
  status: libraryStatus.optional(),
  origin: z.enum(["litscout", "alphaxiv"]).optional(),
  folder: mirrorFolderKey.optional(),
  tags: z.string().max(500).optional(),
  venue: z.string().trim().min(1).max(200).optional(),
  year: z.coerce.number().int().min(1000).max(9999).optional(),
  /** Venue type, as on the day pages; a private upload counts as a preprint. */
  kind: venueKindQuery.optional(),
  /** Only papers from the instance's top venues. */
  top: booleanQuery,
});
export const addPaperInput = z.object({
  paperId: paperIdSchema,
  source: librarySource.default("web"),
  /** Left out, a new entry is saved and an existing one keeps its status. */
  status: addStatus.optional(),
});
export const editLibraryInput = revision
  .extend({
    status: libraryStatus.optional(),
    tags: z.array(z.string().trim().min(1).max(50)).max(20).optional(),
  })
  .refine((v) => v.status !== undefined || v.tags !== undefined);
export const eventInput = addPaperInput.omit({ status: true }).extend({
  kind: eventKind,
  day: z.iso.date().optional(),
});
export const stateQuery = z
  .object({
    day: z.iso.date().optional(),
    paperId: paperIdSchema.optional(),
    after: paperIdSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(100),
  })
  .refine(
    (v) => Boolean(v.day) !== Boolean(v.paperId),
    "Provide a day or a paper ID",
  );
export const bodyMd = z.string().max(4000).regex(/\S/);
export const noteInput = z.object({
  target: paperIdSchema,
  targetType: z.literal("paper").default("paper"),
  bodyMd,
  origin: librarySource.exclude(["feed"]).default("web"),
});
export const editNoteInput = revision.extend({ bodyMd });
export const linkLimit = z.coerce.number().int().min(1).max(20).default(10);
export const linkChecksInput = z.object({
  checks: z
    .array(
      z.object({
        id: z.string().startsWith("lnk_").max(128),
        url: z.url().max(5000),
        httpStatus: z.number().int().min(100).max(599).nullable(),
        checkedAt: z.iso
          .datetime()
          .max(35)
          .transform((v) => new Date(v).toISOString()),
      }),
    )
    .min(1)
    .max(20),
});

export const libraryItemSchema = z.object({
  paperId: paperIdSchema,
  status: libraryStatus,
  tags: z.array(z.string()),
  addedVia: librarySource,
  addedAt: z.string(),
  updatedAt: z.string(),
  deletedAt: z.string().nullable(),
  rev: z.number().int(),
});
const readingLink = z.object({ kind: z.string(), url: z.string() }).nullable();
const mirrorDetails = z.object({
  url: z.string(),
  folders: z.array(mirrorFolderLabel),
  status: libraryStatus.exclude(["archived", "to_read"]),
  highlightCount: z.number().int().nonnegative(),
  hasNotes: z.boolean(),
});
const libraryRowSchema = libraryItemSchema.extend({
  rev: libraryItemSchema.shape.rev.nullable(),
  addedVia: librarySource.nullable(),
  verified: z.boolean().optional(),
  title: z.string(),
  authors: z.array(z.object({ name: z.string() })),
  venue: z.string().nullable(),
  year: z.number().int().nullable(),
  origin: z.array(z.enum(["litscout", "alphaxiv"])),
  readAt: z.string().nullable(),
  link: readingLink,
  alphaXiv: mirrorDetails.optional(),
});
const privateUpload = z.object({
  title: z.string(),
  origin: z.tuple([z.literal("alphaxiv-private")]),
  link: z.object({ kind: z.literal("alphaxiv"), url: z.string() }),
});
const page = <T extends z.ZodType>(item: T) =>
  z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
export const libraryPageSchema = page(
  z.union([libraryRowSchema, privateUpload]),
).extend({
  alphaXiv: z
    .object({
      syncedAt: z.iso.datetime().nullable(),
      folders: z.array(mirrorFolderLabel),
    })
    .optional(),
});
export const readingStateSchema = z.object({
  paperId: paperIdSchema,
  readAt: z.string().nullable(),
  starred: z.boolean(),
  readLater: z.boolean(),
  rating: ratingSchema,
  libraryRev: z.number().int().nullable(),
  /** The library entry's status; null when the paper is not in the library. */
  libraryStatus: libraryStatus.nullable().default(null),
  /** When the reader skipped the paper (seen and judged not worth keeping). */
  skippedAt: z.string().nullable().default(null),
});
export const statePageSchema = page(readingStateSchema);
export const quickNoteSchema = z.object({
  client: z.string().nullable().optional(),
  id: z.string(),
  targetId: paperIdSchema,
  bodyMd: z.string(),
  origin: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  rev: z.number().int(),
});
export const notesPageSchema = page(quickNoteSchema);
const saveCandidateSchema = z.object({
  verified: z.boolean().optional(),
  query: z.string(),
  title: z.string(),
  authors: z.array(z.string()),
  year: z.number().int().optional(),
  venue: z.string().optional(),
  source: z.string(),
  link: readingLink,
});
export const saveResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("confirm"),
    candidates: z.array(saveCandidateSchema),
  }),
  z.object({
    status: z.literal("saved"),
    paperId: paperIdSchema,
    item: libraryItemSchema,
  }),
]);
export type LibraryItem = z.output<typeof libraryItemSchema>;
export type LibraryRow = z.output<typeof libraryRowSchema>;
export type LibraryPage = z.output<typeof libraryPageSchema>;
export type ReadingState = z.output<typeof readingStateSchema>;
export type StatePage = z.output<typeof statePageSchema>;
export type QuickNote = z.output<typeof quickNoteSchema>;
export type SaveCandidate = z.output<typeof saveCandidateSchema>;
export type SaveResult = z.output<typeof saveResultSchema>;

export const libraryCommands = {
  search_library: libraryQuery,
  get_paper: z.object({ ids: paperQuery, full: z.boolean().default(false) }),
  save_paper: saveInput.omit({ source: true }),
  add_note: noteInput.omit({ origin: true, targetType: true }),
  mark_paper: z
    .object({
      paperId: paperIdSchema,
      action: z.enum(["read", "star", "unstar", "rate", "skip", "unskip"]),
      rating: ratingSchema.optional(),
    })
    .refine(
      ({ action, rating }) => (action === "rate") === (rating !== undefined),
      "Provide a rating only when action is rate",
    )
    .meta({
      if: { properties: { action: { const: "rate" } }, required: ["action"] },
      then: { required: ["rating"] },
      else: { not: { required: ["rating"] } },
    }),
};
