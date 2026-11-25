import type { ArxivLinkRecipe } from "@litscout/pipeline/legacy-links";
import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const papers = sqliteTable(
  "papers",
  {
    id: text("id").notNull(),
    title: text("title").notNull(),
    titleNorm: text("title_norm").notNull(),
    vaultTitleNorm: text("vault_title_norm"),
    verified: integer("verified", { mode: "boolean" }).notNull().default(true),
    abstract: text("abstract"),
    tldr: text("tldr")
      .notNull()
      .default(sql`''`),
    derivedArxivLinks: text("derived_arxiv_links", { mode: "json" })
      .$type<ArxivLinkRecipe[]>()
      .notNull()
      .default(sql`'[]'`),
    authors: text("authors", { mode: "json" })
      .$type<{ name: string; orcid?: string }[]>()
      .notNull()
      .default(sql`'[]'`),
    venue: text("venue"),
    venueKind: text("venue_kind"),
    year: integer("year"),
    publishedOn: text("published_on"),
    primaryCategory: text("primary_category"),
    categories: text("categories", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    firstSeenOn: text("first_seen_on"),
    source: text("source")
      .notNull()
      .default(sql`'manual'`),
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
    index("papers_lookup_0").on(t.titleNorm),
    index("papers_vault_title_norm").on(t.vaultTitleNorm, t.deletedAt, t.id),
    index("papers_retention_age")
      .on(sql`coalesce(${t.firstSeenOn},substr(${t.createdAt},1,10))`, t.id)
      .where(sql`${t.deletedAt} IS NULL`),
  ],
);

// Migration 0017 stores this table in its primary key (WITHOUT ROWID).
export const paperIds = sqliteTable(
  "paper_ids",
  {
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    scheme: text("scheme").notNull(),
    value: text("value").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.value, t.scheme] }),
    index("paper_ids_backup_key").on(t.paperId, t.scheme, t.value),
  ],
);

// Migration 0017 stores this table in its primary key (WITHOUT ROWID).
export const paperLinks = sqliteTable(
  "paper_links",
  {
    id: text("id").notNull(),
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    kind: text("kind").notNull(),
    url: text("url").notNull(),
    licence: text("licence"),
    oaStatus: text("oa_status")
      .notNull()
      .default(sql`'unknown'`),
    source: text("source")
      .notNull()
      .default(sql`'manual'`),
    checkedAt: text("checked_at"),
    httpStatus: integer("http_status"),
    userId: text("user_id").notNull().default("u_owner"),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    uniqueIndex("paper_links_unique").on(t.paperId, t.kind, t.url),
    index("paper_links_check_queue").on(t.userId, t.checkedAt, t.id),
  ],
);

export const feedDays = sqliteTable(
  "feed_days",
  {
    day: text("day").notNull(),
    status: text("status")
      .notNull()
      .default(sql`'pending'`),
    counts: text("counts", { mode: "json" })
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'`),
    crawledAt: text("crawled_at"),
    prunedAt: text("pruned_at"),
    rev: integer("rev")
      .notNull()
      .default(sql`1`),
  },
  (t) => [
    primaryKey({ columns: [t.day] }),
    index("feed_days_lookup_0").on(t.status, t.day),
  ],
);

export const feedItems = sqliteTable(
  "feed_items",
  {
    day: text("day")
      .notNull()
      .references(() => feedDays.day, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    paperId: text("paper_id").notNull(),
    source: text("source").notNull(),
    rankInSource: integer("rank_in_source"),
    rankSort: integer("rank_sort").generatedAlwaysAs(
      sql`coalesce(rank_in_source,-1)`,
      { mode: "virtual" },
    ),
    hfUpvotes: integer("hf_upvotes"),
    topics: text("topics", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    shortlisted: integer("shortlisted", { mode: "boolean" })
      .notNull()
      .default(sql`0`),
    rev: integer("rev")
      .notNull()
      .default(sql`1`),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.paperId, t.source] }),
    index("feed_items_lookup_0").on(t.paperId, t.day),
    index("feed_items_read_order").on(t.day, t.rankSort, t.paperId, t.source),
    index("feed_items_keyword_read_order").on(
      t.day,
      sql`shortlisted DESC`,
      t.rankSort,
      t.paperId,
      t.source,
    ),
  ],
);

export const paperIndex = sqliteTable(
  "paper_index",
  {
    paperId: text("paper_id").notNull(),
    arxivId: text("arxiv_id"),
    doi: text("doi"),
    day: text("day").notNull(),
    title: text("title").notNull(),
    titleNorm: text("title_norm"),
    hasCanonical: integer("has_canonical", { mode: "boolean" })
      .notNull()
      .default(false),
    topics: text("topics", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    venue: text("venue"),
  },
  (t) => [
    primaryKey({ columns: [t.paperId] }),
    index("paper_index_lookup_1").on(t.arxivId),
    index("paper_index_lookup_2").on(t.doi),
    index("paper_index_title_norm").on(t.titleNorm, t.hasCanonical, t.paperId),
    index("paper_index_compact_day")
      .on(t.day, t.paperId)
      .where(sql`${t.hasCanonical}=0`),
  ],
);

export const summaries = sqliteTable(
  "summaries",
  {
    paperId: text("paper_id")
      .notNull()
      .references(() => papers.id, {
        onDelete: "cascade",
        onUpdate: "cascade",
      }),
    lang: text("lang")
      .notNull()
      .default(sql`'en'`),
    kind: text("kind")
      .notNull()
      .default(sql`'five_part'`),
    content: text("content", { mode: "json" })
      .$type<{
        tldr: string;
        motivation: string;
        method: string;
        result: string;
        conclusion: string;
      }>()
      .notNull(),
    model: text("model"),
    client: text("client"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    rev: integer("rev")
      .notNull()
      .default(sql`1`),
  },
  (t) => [primaryKey({ columns: [t.paperId, t.lang, t.kind] })],
);

export const digests = sqliteTable(
  "digests",
  {
    day: text("day").notNull(),
    lang: text("lang")
      .notNull()
      .default(sql`'en'`),
    kind: text("kind")
      .notNull()
      .default(sql`'daily'`),
    bodyMd: text("body_md").notNull(),
    picks: text("picks", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    radar: text("radar", { mode: "json" })
      .$type<unknown[]>()
      .notNull()
      .default(sql`'[]'`),
    final: integer("final", { mode: "boolean" })
      .notNull()
      .default(sql`0`),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
    rev: integer("rev")
      .notNull()
      .default(sql`1`),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.lang, t.kind] }),
    index("digests_lookup_0").on(t.kind, t.day),
  ],
);

export const topics = sqliteTable(
  "topics",
  {
    id: text("id").notNull(),
    name: text("name").notNull(),
    keywords: text("keywords", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`),
    color: text("color"),
    description: text("description"),
    sort: integer("sort")
      .notNull()
      .default(sql`0`),
    active: integer("active", { mode: "boolean" })
      .notNull()
      .default(sql`1`),
  },
  (t) => [
    primaryKey({ columns: [t.id] }),
    index("topics_lookup_0").on(t.active, t.sort),
  ],
);

export const retentionRefs = sqliteTable(
  "retention_refs",
  {
    paperId: text("paper_id").notNull(),
    source: text("source").notNull(),
    sourceKey: text("source_key").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.paperId, t.source, t.sourceKey] }),
    index("retention_refs_source").on(t.source, t.sourceKey),
  ],
);
