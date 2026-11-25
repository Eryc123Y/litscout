import type { MirrorFolder } from "@litscout/pipeline/alphaxiv-contracts";
import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { papers } from "./schema-0";
import { vaultNotes } from "./schema-vault";
export const profileDocs = sqliteTable(
  "profile_docs",
  {
    id: text("id").notNull(),
    path: text("path").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    frontmatter: text("frontmatter", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    bodyMd: text("body_md").notNull(),
    bodyHash: text("body_hash").notNull(),
    syncedAt: text("synced_at").notNull(),
    userId: text("user_id")
      .notNull()
      .default(sql`'u_owner'`),
    deletedAt: text("deleted_at"),
    rev: integer("rev")
      .notNull()
      .default(sql`1`),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    uniqueIndex("profile_docs_unique").on(t.userId, t.path),
    index("profile_docs_lookup_0").on(t.path),
    index("profile_docs_lookup_1").on(t.kind),
  ],
);

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").notNull(),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    status: text("status").notNull(),
    summary: text("summary"),
    vaultNoteId: text("vault_note_id").references(() => vaultNotes.id),
    profileDocId: text("profile_doc_id").references(() => profileDocs.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    briefDocId: text("brief_doc_id").references(() => profileDocs.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    keywords: text("keywords", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    userId: text("user_id")
      .notNull()
      .default(sql`'u_owner'`),
    deletedAt: text("deleted_at"),
    rev: integer("rev")
      .notNull()
      .default(sql`1`),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    uniqueIndex("projects_unique").on(t.userId, t.slug),
    uniqueIndex("projects_vault_note").on(t.vaultNoteId),
    index("projects_lookup_0").on(t.slug),
    index("projects_lookup_1").on(t.status),
  ],
);

export const radarGrades = sqliteTable(
  "radar_grades",
  {
    id: text("id").notNull(),
    day: text("day").notNull(),
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    projectId: text("project_id").references(() => projects.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    level: text("level").notNull(),
    fullTextRead: integer("full_text_read", { mode: "boolean" })
      .notNull()
      .default(sql`0`),
    reason: text("reason").notNull(),
    action: text("action").notNull().default(""),
    lookBack: integer("look_back", { mode: "boolean" })
      .notNull()
      .default(false),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("radar_grades_lookup_0").on(t.day),
    index("radar_grades_lookup_1").on(t.paperId),
    index("radar_grades_lookup_2").on(t.projectId),
  ],
);

export const missed = sqliteTable(
  "missed",
  {
    id: text("id").notNull(),
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    foundOn: text("found_on").notNull(),
    where: text("where").notNull(),
    note: text("note"),
    userId: text("user_id")
      .notNull()
      .default(sql`'u_owner'`),
    deletedAt: text("deleted_at"),
    rev: integer("rev")
      .notNull()
      .default(sql`1`),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("missed_lookup_0").on(t.paperId),
    index("missed_lookup_1").on(t.foundOn),
  ],
);

export const libraryItems = sqliteTable(
  "library_items",
  {
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    status: text("status")
      .notNull()
      .default(sql`'saved'`),
    tags: text("tags", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    addedVia: text("added_via").notNull(),
    addedAt: text("added_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    userId: text("user_id")
      .notNull()
      .default(sql`'u_owner'`),
    deletedAt: text("deleted_at"),
    rev: integer("rev")
      .notNull()
      .default(sql`1`),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.paperId] }),
    index("library_items_lookup_0").on(t.userId, t.status),
    index("library_items_lookup_1").on(t.paperId),
    index("library_items_active")
      .on(t.userId, sql`added_at DESC`, sql`paper_id DESC`)
      .where(sql`deleted_at IS NULL`),
  ],
);

export const alphaxivItems = sqliteTable(
  "alphaxiv_items",
  {
    paperId: text("paper_id").references(() => papers.id, {
      onDelete: "cascade",
      onUpdate: "cascade",
    }),
    alphaxivId: text("alphaxiv_id").notNull(),
    paperType: text("paper_type", { enum: ["public", "private"] })
      .notNull()
      .default("public"),
    title: text("title").notNull(),
    folders: text("folders", { mode: "json" })
      .$type<MirrorFolder[]>()
      .notNull()
      .default(sql`'[]'`),
    status: text("status", { enum: ["saved", "reading", "read"] })
      .notNull()
      .default("saved"),
    publicationDate: text("publication_date"),
    annotation: text("annotation", { mode: "json" }).$type<{
      highlightCount: number;
      hasNotes: boolean;
    }>(),
    savedAt: text("saved_at"),
    syncedAt: text("synced_at").notNull(),
    libraryAddedAt: text("library_added_at").generatedAlwaysAs(
      sql`coalesce(saved_at,synced_at)`,
    ),
    libraryKey: text("library_key").generatedAlwaysAs(
      sql`CASE paper_type WHEN 'public' THEN paper_id ELSE 'private:'||alphaxiv_id END`,
    ),
    removedAt: text("removed_at"),
    userId: text("user_id")
      .notNull()
      .default(sql`'u_owner'`),
    deletedAt: text("deleted_at"),
    rev: integer("rev")
      .notNull()
      .default(sql`1`),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.paperType, t.alphaxivId] }),
    index("alphaxiv_items_lookup_0").on(t.alphaxivId),
    index("alphaxiv_items_lookup_1").on(t.paperId),
    index("alphaxiv_items_active")
      .on(t.userId, t.paperType, t.paperId)
      .where(sql`removed_at IS NULL AND deleted_at IS NULL`),
    index("alphaxiv_library_order")
      .on(t.userId, t.libraryAddedAt, t.libraryKey)
      .where(sql`removed_at IS NULL AND deleted_at IS NULL`),
  ],
);

export const alphaxivFolderCounts = sqliteTable(
  "alphaxiv_folder_counts",
  {
    userId: text("user_id").notNull(),
    folderId: text("folder_id").notNull(),
    path: text("path").notNull(),
    count: integer("n").notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.folderId, t.path] })],
);

export const notes = sqliteTable(
  "notes",
  {
    id: text("id").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    client: text("client"),
    bodyMd: text("body_md").notNull(),
    origin: text("origin").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    userId: text("user_id")
      .notNull()
      .default(sql`'u_owner'`),
    deletedAt: text("deleted_at"),
    rev: integer("rev")
      .notNull()
      .default(sql`1`),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("notes_lookup_0").on(t.userId, t.targetType, t.targetId),
    index("notes_retention_paper")
      .on(t.targetId)
      .where(sql`${t.targetType}='paper'`),
  ],
);

export const paperState = sqliteTable(
  "paper_state",
  {
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    readAt: text("read_at"),
    starred: integer("starred", { mode: "boolean" })
      .notNull()
      .default(sql`0`),
    readLater: integer("read_later", { mode: "boolean" })
      .notNull()
      .default(sql`0`),
    rating: text("rating")
      .notNull()
      .default(sql`'none'`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    userId: text("user_id")
      .notNull()
      .default(sql`'u_owner'`),
    deletedAt: text("deleted_at"),
    rev: integer("rev")
      .notNull()
      .default(sql`1`),
    skippedAt: text("skipped_at"),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.paperId] }),
    index("paper_state_lookup_0").on(t.paperId),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").notNull(),
    userId: text("user_id")
      .notNull()
      .default(sql`'u_owner'`),
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    kind: text("kind").notNull(),
    day: text("day").notNull(),
    source: text("source").notNull(),
    at: text("at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("events_lookup_0").on(t.userId, t.day),
    index("events_lookup_1").on(t.paperId),
    index("events_ratings_by_day")
      .on(t.userId, t.day, t.at, t.id, t.paperId, t.kind, t.source)
      .where(sql`kind IN ('rate_up','rate_down','rate_clear')`),
  ],
);

export const ideas = sqliteTable(
  "ideas",
  {
    id: text("id").notNull(),
    title: text("title").notNull(),
    bodyMd: text("body_md").notNull(),
    status: text("status")
      .notNull()
      .default(sql`'seed'`),
    origin: text("origin").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    userId: text("user_id")
      .notNull()
      .default(sql`'u_owner'`),
    deletedAt: text("deleted_at"),
    rev: integer("rev")
      .notNull()
      .default(sql`1`),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("ideas_lookup_0").on(t.userId, t.status),
  ],
);
