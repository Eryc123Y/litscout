import { vaultRequests } from "./schema-vault";
import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { topics, feedDays } from "./schema-0";
import { ideas } from "./schema-1";
import type { TokenScope } from "./contracts";
/** Physical table is WITHOUT ROWID; see migration 0004. */
export const dailyWriteUsage = sqliteTable(
  "daily_write_usage",
  {
    day: text("day").notNull(),
    rowsWritten: integer("rows_written").notNull().default(0),
    reserved: integer("reserved").notNull().default(0),
    unaccounted: integer("unaccounted").notNull().default(0),
    estimateOverrun: integer("estimate_overrun").notNull().default(0),
    pruneCharged: integer("prune_charged").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day] })],
);
/** Physical table is WITHOUT ROWID with no secondary indexes; migration 0005. */
export const writeLeases = sqliteTable(
  "write_leases",
  {
    id: text("id").notNull(),
    day: text("day").notNull(),
    reserved: integer("reserved").notNull(),
    estimate: integer("estimate").notNull(),
    createdAt: text("created_at").notNull(),
    expired: integer("expired").notNull().default(0),
    expiryDay: text("expiry_day"),
  },
  (t) => [primaryKey({ columns: [t.id] })],
);
export const ideaLinks = sqliteTable(
  "idea_links",
  {
    ideaId: text("idea_id")
      .notNull()
      .references(() => ideas.id, { onDelete: "cascade", onUpdate: "cascade" }),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    relation: text("relation").notNull(),
    note: text("note"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [
    primaryKey({ columns: [t.ideaId, t.targetType, t.targetId, t.relation] }),
    index("idea_links_lookup_0").on(t.targetType, t.targetId),
  ],
);

export const workingPapers = sqliteTable(
  "working_papers",
  {
    id: text("id").notNull(),
    title: text("title").notNull(),
    abstractMd: text("abstract_md")
      .notNull()
      .default(sql`''`),
    outlineMd: text("outline_md")
      .notNull()
      .default(sql`''`),
    status: text("status")
      .notNull()
      .default(sql`'sketch'`),
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
    index("working_papers_lookup_0").on(t.userId, t.status),
  ],
);

export const workingPaperIdeas = sqliteTable(
  "working_paper_ideas",
  {
    workingPaperId: text("working_paper_id")
      .notNull()
      .references(() => workingPapers.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    ideaId: text("idea_id")
      .notNull()
      .references(() => ideas.id, { onDelete: "cascade", onUpdate: "cascade" }),
    position: integer("position").notNull(),
    role: text("role").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workingPaperId, t.ideaId] }),
    index("working_paper_ideas_lookup_0").on(t.ideaId),
    index("working_paper_ideas_lookup_1").on(t.workingPaperId, t.position),
  ],
);

export const suggestions = sqliteTable(
  "suggestions",
  {
    id: text("id").notNull(),
    day: text("day").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    bodyMd: text("body_md").notNull(),
    ideaIds: text("idea_ids", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    paperIds: text("paper_ids", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    projectIds: text("project_ids", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    status: text("status")
      .notNull()
      .default(sql`'new'`),
    resolvedAt: text("resolved_at"),
    requestId: text("request_id").references(() => vaultRequests.id),
    createdBy: text("created_by").notNull(),
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
    index("suggestions_lookup_0").on(t.userId, t.day, t.status),
    index("suggestions_by_owner_id")
      .on(t.userId, t.id)
      .where(sql`${t.deletedAt} IS NULL`),
    index("suggestions_by_request")
      .on(t.requestId)
      .where(sql`${t.requestId} IS NOT NULL`),
  ],
);

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").notNull(),
    kind: text("kind").notNull(),
    day: text("day").notNull(),
    status: text("status").notNull(),
    startedAt: text("started_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    finishedAt: text("finished_at"),
    stats: text("stats", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`),
    error: text("error"),
    rev: integer("rev")
      .notNull()
      .default(sql`1`),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("runs_lookup_0").on(t.day, t.kind),
    index("runs_lookup_1").on(t.status),
  ],
);

export const syncCursors = sqliteTable(
  "sync_cursors",
  {
    name: text("name").notNull(),
    value: text("value").notNull(),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (t) => [primaryKey({ columns: [t.name] })],
);

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: text("id").notNull(),
    name: text("name").notNull(),
    hash: text("hash").notNull(),
    scopes: text("scopes", { mode: "json" }).$type<TokenScope[]>().notNull(),
    legacyVault: integer("legacy_vault", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    lastUsedAt: text("last_used_at"),
    expiresAt: text("expires_at"),
    revokedAt: text("revoked_at"),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    uniqueIndex("api_tokens_hash").on(t.hash),
    index("api_tokens_lookup_0").on(t.revokedAt),
  ],
);

export const trendSnapshots = sqliteTable(
  "trend_snapshots",
  {
    topicId: text("topic_id")
      .notNull()
      .references(() => topics.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    period: text("period").notNull(),
    paperCount: integer("paper_count").notNull(),
    topPaperIds: text("top_paper_ids", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    summaryMd: text("summary_md"),
    computedAt: text("computed_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.topicId, t.period] }),
    index("trend_snapshots_lookup_0").on(t.period),
  ],
);

/** Incremental per-day counters maintained by SQL triggers; migration 0006. */
export const feedReadCounts = sqliteTable(
  "feed_read_counts",
  {
    day: text("day")
      .notNull()
      .references(() => feedDays.day, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    n: integer("n").notNull(),
  },
  (t) => [primaryKey({ columns: [t.day, t.kind, t.key] })],
);

export const dailyRuns = sqliteTable(
  "daily_runs",
  {
    id: text("id").notNull(),
    runDay: text("run_day").notNull(),
    startedAt: text("started_at").notNull(),
    targetDay: text("target_day").notNull(),
    finishedAt: text("finished_at"),
    steps: text("steps", { mode: "json" }),
    rowsWritten: integer("rows_written"),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("daily_runs_recent").on(sql`${t.startedAt} DESC`, sql`${t.id} DESC`),
    index("daily_runs_reported")
      .on(t.runDay)
      .where(sql`${t.finishedAt} IS NOT NULL`),
  ],
);
