import { z } from "zod";
import { configuredTopicsSchema } from "@litscout/core/config";

const text = z.string();
const nullable = text.nullable();
const number = z.number().int();
const list = z.array(text);
const flag = z.union([z.literal(0), z.literal(1)]);
const rev = { rev: number };
const dates = { created_at: text, updated_at: text };
const digest = {
  day: z.iso.date(),
  lang: text,
  body_md: text,
  picks: list,
  radar: z.array(z.json()),
  final: flag,
  ...dates,
  ...rev,
};

/** Every exported column is selected by name. This is the v1 wire format. */
export const backupSectionSchemas = {
  library: z.strictObject({
    paper_id: text,
    status: text,
    tags: list,
    added_via: text,
    added_at: text,
    updated_at: text,
    ...rev,
  }),
  alphaXiv: z.strictObject({
    alphaxiv_id: text,
    paper_type: z.enum(["public", "private"]),
    paper_id: nullable,
    title: text,
    folders: z.array(z.json()),
    status: text,
    publication_date: nullable,
    annotation: z.json().nullable(),
    saved_at: nullable,
    synced_at: text,
    ...rev,
  }),
  paperState: z.strictObject({
    paper_id: text,
    read_at: nullable,
    starred: flag,
    read_later: flag,
    rating: text,
    updated_at: text,
    // Absent from bundles written before schema version 26.
    skipped_at: nullable.optional(),
    ...rev,
  }),
  quickNotes: z.strictObject({
    id: text,
    target_id: text,
    body_md: text,
    origin: text,
    client: nullable,
    ...dates,
    ...rev,
  }),
  digests: z.strictObject({ ...digest, kind: z.literal("daily") }),
  weeklyDigests: z.strictObject({ ...digest, kind: z.literal("weekly") }),
  topics: z.strictObject({
    id: text,
    name: text,
    keywords: list,
    color: nullable,
    description: nullable,
    sort: number,
    active: flag,
  }),
  projects: z.strictObject({
    id: text,
    slug: text,
    title: text,
    status: text,
    summary: nullable,
    profile_doc_id: nullable,
    brief_doc_id: nullable,
    vault_note_id: nullable,
    keywords: list,
    updated_at: text,
    ...rev,
  }),
  vaultIndex: z.strictObject({
    id: text,
    path: text,
    kind: text,
    title: text,
    frontmatter: z.record(text, z.json()),
    hash: text,
    body_hash: text,
    fingerprint: text,
    synced_at: text,
  }),
  ideaIndex: z.strictObject({
    id: text,
    vault_note_id: text,
    title: text,
    status: nullable,
    description: nullable,
    project_id: nullable,
    paper_ids: list,
    updated_at: text,
  }),
  workingPaperIndex: z.strictObject({
    id: text,
    vault_note_id: text,
    title: text,
    status: nullable,
    project_id: nullable,
    idea_ids: list,
    paper_ids: list,
    updated_at: text,
  }),
  captures: z.strictObject({
    id: text,
    title: text,
    body_md: text,
    source_paper_id: nullable,
    suggestion_id: nullable,
    created_at: text,
    handed_off_at: nullable,
  }),
  vaultRequests: z.strictObject({
    id: text,
    kind: text,
    target_note_id: nullable,
    payload: z.record(text, z.json()),
    base_hash: nullable,
    state: text,
    reason: nullable,
    origin: text,
    created_at: text,
    resolved_at: nullable,
    result_hash: nullable,
  }),
  suggestions: z.strictObject({
    id: text,
    day: z.iso.date(),
    kind: text,
    title: text,
    body_md: text,
    idea_ids: list,
    paper_ids: list,
    project_ids: list,
    status: text,
    resolved_at: nullable,
    created_by: text,
    request_id: nullable,
    ...rev,
  }),
};
export type BackupSection = keyof typeof backupSectionSchemas;
export const backupSectionSchema = z.enum(
  Object.keys(backupSectionSchemas) as BackupSection[],
);
export const backupSections = backupSectionSchema.options;

type PaperReference = {
  column: string;
  array?: true;
  key?: string;
};
const digestPaperReferences = [
  { column: "picks", array: true },
  { column: "radar", array: true, key: "paperId" },
] as const;
// The client follows these references when paging papers. The count batch
// uses the same fields to count distinct, exportable papers and their children.
export const backupPaperReferences: Partial<
  Record<BackupSection, readonly PaperReference[]>
> = {
  library: [{ column: "paper_id" }],
  alphaXiv: [{ column: "paper_id" }],
  paperState: [{ column: "paper_id" }],
  quickNotes: [{ column: "target_id" }],
  digests: digestPaperReferences,
  weeklyDigests: digestPaperReferences,
  ideaIndex: [{ column: "paper_ids", array: true }],
  workingPaperIndex: [{ column: "paper_ids", array: true }],
  captures: [{ column: "source_paper_id" }],
  vaultRequests: [{ column: "payload", key: "paperId" }],
  suggestions: [{ column: "paper_ids", array: true }],
};

export const backupSectionKeys = {
  library: ["paper_id"],
  alphaXiv: ["paper_type", "alphaxiv_id"],
  paperState: ["paper_id"],
  quickNotes: ["id"],
  digests: ["day", "lang", "kind"],
  weeklyDigests: ["day", "lang", "kind"],
  topics: ["id"],
  projects: ["id"],
  vaultIndex: ["id"],
  ideaIndex: ["id"],
  workingPaperIndex: ["id"],
  captures: ["id"],
  vaultRequests: ["id"],
  suggestions: ["id"],
} as const satisfies Record<BackupSection, readonly string[]>;
export const backupPageSize = 25;
export const backupPageSchema = <Row extends z.ZodType>(row: Row) =>
  z.strictObject({
    items: z.array(row).max(backupPageSize),
    nextCursor: text.nullable(),
  });

export const backupPaperSchema = z.strictObject({
  id: text,
  derived_arxiv_links: z
    .array(
      z.strictObject({
        kind: z.enum(["landing", "pdf_arxiv"]),
        id: text,
      }),
    )
    .optional(),
  title: text,
  abstract: nullable,
  tldr: text,
  authors: z.array(z.json()),
  venue: nullable,
  venue_kind: nullable,
  year: number.nullable(),
  published_on: nullable,
  primary_category: nullable,
  categories: list,
  first_seen_on: nullable,
  source: text,
  verified: flag,
  ...dates,
  ...rev,
});
export const backupCompactPaperSchema = z.strictObject({
  id: text,
  compact: z.literal(true),
  arxiv_id: nullable,
  doi: nullable,
  day: z.iso.date(),
  title: text,
  title_norm: nullable,
  topics: list,
  venue: nullable,
});
export const backupPaperRecordSchema = z.union([
  backupPaperSchema,
  backupCompactPaperSchema,
]);
export const backupIdentifierSchema = z.strictObject({
  paper_id: text,
  scheme: text,
  value: text,
});
export const backupLinkSchema = z.strictObject({
  id: text,
  paper_id: text,
  kind: text,
  url: text,
  licence: nullable,
  oa_status: text,
  source: text,
  checked_at: nullable,
  http_status: number.nullable(),
});

// One metadata statement and at most two child statements per paper.
export const backupPaperBatchSize = Math.floor((40 - 1) / 2);
export const backupPaperChildPageSize = 20;
const childCursor = z.tuple([text, text]).nullable();
export const backupPaperCursorSchema = z
  .strictObject({
    id: text
      .min(1)
      .max(128)
      .regex(/^[\w-]+$/),
    identifiersAfter: childCursor.optional(),
    linksAfter: childCursor.optional(),
  })
  .refine(
    ({ identifiersAfter, linksAfter }) =>
      (identifiersAfter === undefined && linksAfter === undefined) ||
      (identifiersAfter !== undefined &&
        linksAfter !== undefined &&
        (identifiersAfter !== null || linksAfter !== null)),
  );
export const backupPaperBatchSchema = z
  .array(backupPaperCursorSchema)
  .min(1)
  .max(backupPaperBatchSize)
  .refine((batch) => new Set(batch.map(({ id }) => id)).size === batch.length);
export const backupPaperPageSchema = z
  .array(
    z.strictObject({
      id: text,
      paper: backupPaperRecordSchema.nullable(),
      identifiers: z
        .array(backupIdentifierSchema)
        .max(backupPaperChildPageSize),
      links: z.array(backupLinkSchema).max(backupPaperChildPageSize),
      identifiersAfter: childCursor,
      linksAfter: childCursor,
    }),
  )
  .max(backupPaperBatchSize);
export const backupDataKeys = {
  ...backupSectionKeys,
  papers: ["id"],
  paperIdentifiers: ["scheme", "value"],
  paperLinks: ["id"],
} as const;
export const backupDataSections = Object.keys(
  backupDataKeys,
) as (keyof typeof backupDataKeys)[];
const bundleInstanceSchema = z.strictObject({
  instanceName: text.min(1),
  configuredTopics: configuredTopicsSchema,
});

const count = z.number().int().nonnegative();
const backupCountsSchema = z.record(
  z.enum([...backupDataSections, "configuredTopics"]),
  count,
);
export const backupManifestSchema = bundleInstanceSchema.extend({
  expectedCounts: backupCountsSchema,
});

const sectionArrays = Object.fromEntries(
  backupSections.map((section) => [
    section,
    z.array(backupSectionSchemas[section]),
  ]),
) as {
  [Section in BackupSection]: z.ZodArray<
    (typeof backupSectionSchemas)[Section]
  >;
};
export const backupBundleSchema = bundleInstanceSchema.extend({
  schemaVersion: z.literal(1),
  createdAt: z.iso.datetime(),
  expectedCounts: backupCountsSchema,
  counts: backupCountsSchema,
  sha256: text.regex(/^[0-9a-f]{64}$/),
  data: z.strictObject({
    ...sectionArrays,
    papers: z.array(backupPaperRecordSchema),
    paperIdentifiers: z.array(backupIdentifierSchema),
    paperLinks: z.array(backupLinkSchema),
  }),
});

export type BackupBundle = z.output<typeof backupBundleSchema>;
export type BackupCounts = z.output<typeof backupCountsSchema>;
export type BackupPaperCursor = z.output<typeof backupPaperCursorSchema>;
