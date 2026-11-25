import { sql } from "drizzle-orm";
import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type { SyncReport, VaultNote } from "@litscout/pipeline/vault-contracts";
import { projects } from "./schema-1";

export const vaultNotes = sqliteTable(
  "vault_notes",
  {
    id: text("id").notNull(),
    path: text("path").notNull(),
    kind: text("kind").$type<VaultNote["kind"]>().notNull(),
    title: text("title").notNull(),
    titleNorm: text("title_norm"),
    titlePaperId: text("title_paper_id"),
    frontmatter: text("frontmatter", { mode: "json" })
      .$type<VaultNote["frontmatter"]>()
      .notNull(),
    hash: text("hash").notNull(),
    bodyHash: text("body_hash").notNull(),
    fingerprint: text("fingerprint").notNull(),
    /** Uploaded body of a project, idea or draft note, read-only on the web. */
    bodyMd: text("body_md"),
    syncedAt: text("synced_at").notNull(),
    deletedAt: text("deleted_at"),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("vault_notes_retention_title")
      .on(t.titleNorm)
      .where(sql`${t.kind}='paper_note' AND ${t.deletedAt} IS NULL`),
    index("vault_notes_kind")
      .on(t.kind, t.id)
      .where(sql`${t.deletedAt} IS NULL`),
    index("vault_notes_arxiv")
      .on(sql`lower(json_extract(${t.frontmatter}, '$.arxiv'))`)
      .where(sql`${t.kind}='paper_note' AND ${t.deletedAt} IS NULL`),
    index("vault_notes_doi")
      .on(sql`lower(json_extract(${t.frontmatter}, '$.doi'))`)
      .where(sql`${t.kind}='paper_note' AND ${t.deletedAt} IS NULL`),
    index("vault_notes_title_paper")
      .on(t.titlePaperId, t.path)
      .where(sql`${t.titlePaperId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    index("vault_notes_unkeyed_title").on(t.id)
      .where(sql`${t.kind}='paper_note' AND ${t.deletedAt} IS NULL AND ${t.titleNorm} IS NULL
        AND json_extract(${t.frontmatter},'$.arxiv') IS NULL
        AND json_extract(${t.frontmatter},'$.doi') IS NULL`),
  ],
);

const jsonIds = (name: string) =>
  text(name, { mode: "json" })
    .$type<string[]>()
    .notNull()
    .default(sql`'[]'`);

export const ideaIndex = sqliteTable(
  "idea_index",
  {
    id: text("id").notNull(),
    vaultNoteId: text("vault_note_id")
      .notNull()
      .references(() => vaultNotes.id),
    title: text("title").notNull(),
    status: text("status"),
    description: text("description"),
    projectId: text("project_id").references(() => projects.id),
    paperIds: jsonIds("paper_ids"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("idea_index_project").on(t.projectId),
  ],
);

export const workingPaperIndex = sqliteTable(
  "working_paper_index",
  {
    id: text("id").notNull(),
    vaultNoteId: text("vault_note_id")
      .notNull()
      .references(() => vaultNotes.id),
    title: text("title").notNull(),
    status: text("status"),
    projectId: text("project_id").references(() => projects.id),
    ideaIds: jsonIds("idea_ids"),
    paperIds: jsonIds("paper_ids"),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.id] })],
);

export const vaultRequests = sqliteTable(
  "vault_requests",
  {
    id: text("id").notNull(),
    kind: text("kind").notNull(),
    targetNoteId: text("target_note_id").references(() => vaultNotes.id),
    payload: text("payload", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull(),
    baseHash: text("base_hash"),
    state: text("state").notNull().default("queued"),
    reason: text("reason"),
    origin: text("origin").notNull(),
    createdAt: text("created_at").notNull(),
    resolvedAt: text("resolved_at"),
    resultHash: text("result_hash"),
    claim: text("claim"),
    claimUntil: text("claim_until"),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("vault_requests_queue").on(t.state, t.createdAt, t.id),
    index("vault_requests_resolved").on(t.state, sql`${t.resolvedAt} DESC`),
    index("vault_requests_target").on(
      t.targetNoteId,
      t.kind,
      sql`${t.createdAt} DESC`,
      sql`${t.id} DESC`,
    ),
    index("vault_requests_retention_paper").on(
      sql`json_extract(${t.payload},'$.paperId')`,
    ),
    index("vault_requests_pending_paper")
      .on(sql`json_extract(${t.payload}, '$.paperId')`, t.kind)
      .where(sql`${t.state}='queued'`),
    uniqueIndex("vault_requests_make")
      .on(sql`json_extract(${t.payload}, '$.paperId')`)
      .where(sql`${t.kind}='make_paper_note' AND ${t.state}='queued'`),
  ],
);

export const captures = sqliteTable(
  "captures",
  {
    id: text("id")
      .notNull()
      .references(() => vaultRequests.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().default("u_owner"),
    title: text("title").notNull(),
    bodyMd: text("body_md").notNull().default(""),
    sourcePaperId: text("source_paper_id"),
    suggestionId: text("suggestion_id"),
    createdAt: text("created_at").notNull(),
    handedOffAt: text("handed_off_at"),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("captures_retention_paper").on(t.sourcePaperId),
  ],
);

export const vaultSync = sqliteTable(
  "vault_sync",
  {
    id: integer("id").notNull(),
    snapshot: text("snapshot"),
    publishToken: text("publish_token"),
    noteCount: integer("note_count").notNull().default(0),
    report: text("report", { mode: "json" }).$type<SyncReport>(),
    reportedAt: text("reported_at"),
  },
  (t) => [primaryKey({ columns: [t.id] })],
);

export const vaultIndexParts = sqliteTable(
  "vault_index_parts",
  {
    part: integer("part").notNull(),
    snapshot: text("snapshot").notNull(),
    notes: text("notes", { mode: "json" })
      .$type<Array<VaultNote & { fingerprint: string }>>()
      .notNull(),
    removed: text("removed", { mode: "json" }).$type<string[]>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.part] })],
);
