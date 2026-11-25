PRAGMA foreign_keys = ON;

CREATE TABLE papers (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "title_norm" TEXT NOT NULL,
  "abstract" TEXT,
  "tldr" TEXT NOT NULL DEFAULT '',
  "authors" TEXT NOT NULL DEFAULT '[]',
  "venue" TEXT,
  "venue_kind" TEXT,
  "year" INTEGER,
  "published_on" TEXT,
  "primary_category" TEXT,
  "categories" TEXT NOT NULL DEFAULT '[]',
  "first_seen_on" TEXT,
  "source" TEXT NOT NULL DEFAULT 'manual',
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "user_id" TEXT NOT NULL DEFAULT 'u_owner',
  "deleted_at" TEXT,
  "rev" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("id")
);

CREATE INDEX papers_lookup_0 ON papers (title_norm);

CREATE INDEX papers_lookup_1 ON papers (published_on);

CREATE INDEX papers_lookup_2 ON papers (first_seen_on);

CREATE TABLE paper_ids (
  "paper_id" TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "scheme" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  PRIMARY KEY ("scheme", "value")
);

CREATE INDEX paper_ids_lookup_0 ON paper_ids (paper_id);

CREATE TABLE paper_links (
  "id" TEXT NOT NULL,
  "paper_id" TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "kind" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "licence" TEXT,
  "oa_status" TEXT NOT NULL DEFAULT 'unknown',
  "source" TEXT NOT NULL DEFAULT 'manual',
  "checked_at" TEXT,
  "http_status" INTEGER,
  PRIMARY KEY ("id")
);

CREATE INDEX paper_links_lookup_0 ON paper_links (paper_id);

CREATE INDEX paper_links_lookup_1 ON paper_links (checked_at);

CREATE TABLE feed_days (
  "day" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "counts" TEXT NOT NULL DEFAULT '{}',
  "crawled_at" TEXT,
  "pruned_at" TEXT,
  "rev" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("day")
);

CREATE INDEX feed_days_lookup_0 ON feed_days (status, day);

CREATE TABLE feed_items (
  "day" TEXT NOT NULL REFERENCES feed_days(day) ON DELETE CASCADE ON UPDATE CASCADE,
  "paper_id" TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "source" TEXT NOT NULL,
  "rank_in_source" INTEGER,
  "hf_upvotes" INTEGER,
  "topics" TEXT NOT NULL DEFAULT '[]',
  "shortlisted" INTEGER NOT NULL DEFAULT 0,
  "rev" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("day", "paper_id", "source")
);

CREATE INDEX feed_items_lookup_0 ON feed_items (paper_id);

CREATE INDEX feed_items_lookup_1 ON feed_items (day, shortlisted);

CREATE TABLE paper_index (
  "paper_id" TEXT NOT NULL,
  "arxiv_id" TEXT,
  "doi" TEXT,
  "day" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "topics" TEXT NOT NULL DEFAULT '[]',
  "venue" TEXT,
  PRIMARY KEY ("paper_id")
);

CREATE INDEX paper_index_lookup_0 ON paper_index (day);

CREATE INDEX paper_index_lookup_1 ON paper_index (arxiv_id);

CREATE INDEX paper_index_lookup_2 ON paper_index (doi);

CREATE INDEX paper_index_lookup_3 ON paper_index (title);

CREATE TABLE summaries (
  "paper_id" TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "lang" TEXT NOT NULL DEFAULT 'en',
  "kind" TEXT NOT NULL DEFAULT 'five_part',
  "content" TEXT NOT NULL,
  "model" TEXT,
  "client" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "rev" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("paper_id", "lang", "kind")
);

CREATE TABLE digests (
  "day" TEXT NOT NULL,
  "lang" TEXT NOT NULL DEFAULT 'en',
  "kind" TEXT NOT NULL DEFAULT 'daily',
  "body_md" TEXT NOT NULL,
  "picks" TEXT NOT NULL DEFAULT '[]',
  "radar" TEXT NOT NULL DEFAULT '[]',
  "final" INTEGER NOT NULL DEFAULT 0,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "rev" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("day", "lang", "kind")
);

CREATE INDEX digests_lookup_0 ON digests (kind, day);

CREATE TABLE topics (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "keywords" TEXT NOT NULL DEFAULT '[]',
  "color" TEXT,
  "description" TEXT,
  "sort" INTEGER NOT NULL DEFAULT 0,
  "active" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("id")
);

CREATE INDEX topics_lookup_0 ON topics (active, sort);

CREATE TABLE profile_docs (
  "id" TEXT NOT NULL,
  "path" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "frontmatter" TEXT NOT NULL DEFAULT '{}',
  "body_md" TEXT NOT NULL,
  "body_hash" TEXT NOT NULL,
  "synced_at" TEXT NOT NULL,
  "user_id" TEXT NOT NULL DEFAULT 'u_owner',
  "deleted_at" TEXT,
  "rev" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("id")
);

CREATE INDEX profile_docs_lookup_0 ON profile_docs (path);

CREATE INDEX profile_docs_lookup_1 ON profile_docs (kind);

CREATE TABLE projects (
  "id" TEXT NOT NULL,
  "slug" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "summary" TEXT,
  "profile_doc_id" TEXT REFERENCES profile_docs(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "brief_doc_id" TEXT REFERENCES profile_docs(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "keywords" TEXT NOT NULL DEFAULT '[]',
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "user_id" TEXT NOT NULL DEFAULT 'u_owner',
  "deleted_at" TEXT,
  "rev" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("id")
);

CREATE INDEX projects_lookup_0 ON projects (slug);

CREATE INDEX projects_lookup_1 ON projects (status);

CREATE TABLE radar_grades (
  "id" TEXT NOT NULL,
  "day" TEXT NOT NULL,
  "paper_id" TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "project_id" TEXT REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "level" TEXT NOT NULL,
  "full_text_read" INTEGER NOT NULL DEFAULT 0,
  "reason" TEXT NOT NULL,
  PRIMARY KEY ("id")
);

CREATE INDEX radar_grades_lookup_0 ON radar_grades (day);

CREATE INDEX radar_grades_lookup_1 ON radar_grades (paper_id);

CREATE INDEX radar_grades_lookup_2 ON radar_grades (project_id);

CREATE TABLE missed (
  "id" TEXT NOT NULL,
  "paper_id" TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "found_on" TEXT NOT NULL,
  "where" TEXT NOT NULL,
  "note" TEXT,
  "user_id" TEXT NOT NULL DEFAULT 'u_owner',
  "deleted_at" TEXT,
  "rev" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("id")
);

CREATE INDEX missed_lookup_0 ON missed (paper_id);

CREATE INDEX missed_lookup_1 ON missed (found_on);

CREATE TABLE library_items (
  "paper_id" TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "status" TEXT NOT NULL DEFAULT 'saved',
  "tags" TEXT NOT NULL DEFAULT '[]',
  "added_via" TEXT NOT NULL,
  "added_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "user_id" TEXT NOT NULL DEFAULT 'u_owner',
  "deleted_at" TEXT,
  "rev" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("user_id", "paper_id")
);

CREATE INDEX library_items_lookup_0 ON library_items (user_id, status);

CREATE INDEX library_items_lookup_1 ON library_items (paper_id);

CREATE TABLE alphaxiv_items (
  "paper_id" TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "alphaxiv_id" TEXT NOT NULL,
  "folders" TEXT NOT NULL DEFAULT '[]',
  "saved_at" TEXT,
  "synced_at" TEXT NOT NULL,
  "removed_at" TEXT,
  "user_id" TEXT NOT NULL DEFAULT 'u_owner',
  "deleted_at" TEXT,
  "rev" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("user_id", "paper_id")
);

CREATE INDEX alphaxiv_items_lookup_0 ON alphaxiv_items (alphaxiv_id);

CREATE INDEX alphaxiv_items_lookup_1 ON alphaxiv_items (paper_id);

CREATE TABLE notes (
  "id" TEXT NOT NULL,
  "target_type" TEXT NOT NULL,
  "target_id" TEXT NOT NULL,
  "body_md" TEXT NOT NULL,
  "origin" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "user_id" TEXT NOT NULL DEFAULT 'u_owner',
  "deleted_at" TEXT,
  "rev" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("id")
);

CREATE INDEX notes_lookup_0 ON notes (user_id, target_type, target_id);

CREATE TABLE paper_state (
  "paper_id" TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "read_at" TEXT,
  "starred" INTEGER NOT NULL DEFAULT 0,
  "read_later" INTEGER NOT NULL DEFAULT 0,
  "rating" TEXT NOT NULL DEFAULT 'none',
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "user_id" TEXT NOT NULL DEFAULT 'u_owner',
  "deleted_at" TEXT,
  "rev" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("user_id", "paper_id")
);

CREATE INDEX paper_state_lookup_0 ON paper_state (paper_id);

CREATE TABLE events (
  "id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL DEFAULT 'u_owner',
  "paper_id" TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "kind" TEXT NOT NULL,
  "day" TEXT NOT NULL,
  "source" TEXT NOT NULL,
  "at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY ("id")
);

CREATE INDEX events_lookup_0 ON events (user_id, day);

CREATE INDEX events_lookup_1 ON events (paper_id);

CREATE TABLE ideas (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body_md" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'seed',
  "origin" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "user_id" TEXT NOT NULL DEFAULT 'u_owner',
  "deleted_at" TEXT,
  "rev" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("id")
);

CREATE INDEX ideas_lookup_0 ON ideas (user_id, status);

CREATE TABLE idea_links (
  "idea_id" TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "target_type" TEXT NOT NULL,
  "target_id" TEXT NOT NULL,
  "relation" TEXT NOT NULL,
  "note" TEXT,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY ("idea_id", "target_type", "target_id", "relation")
);

CREATE INDEX idea_links_lookup_0 ON idea_links (target_type, target_id);

CREATE TABLE working_papers (
  "id" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "abstract_md" TEXT NOT NULL DEFAULT '',
  "outline_md" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'sketch',
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "user_id" TEXT NOT NULL DEFAULT 'u_owner',
  "deleted_at" TEXT,
  "rev" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("id")
);

CREATE INDEX working_papers_lookup_0 ON working_papers (user_id, status);

CREATE TABLE working_paper_ideas (
  "working_paper_id" TEXT NOT NULL REFERENCES working_papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "idea_id" TEXT NOT NULL REFERENCES ideas(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "position" INTEGER NOT NULL,
  "role" TEXT NOT NULL,
  PRIMARY KEY ("working_paper_id", "idea_id")
);

CREATE INDEX working_paper_ideas_lookup_0 ON working_paper_ideas (idea_id);

CREATE INDEX working_paper_ideas_lookup_1 ON working_paper_ideas (working_paper_id, position);

CREATE TABLE suggestions (
  "id" TEXT NOT NULL,
  "day" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body_md" TEXT NOT NULL,
  "idea_ids" TEXT NOT NULL DEFAULT '[]',
  "paper_ids" TEXT NOT NULL DEFAULT '[]',
  "project_ids" TEXT NOT NULL DEFAULT '[]',
  "status" TEXT NOT NULL DEFAULT 'new',
  "resolved_at" TEXT,
  "created_by" TEXT NOT NULL,
  "user_id" TEXT NOT NULL DEFAULT 'u_owner',
  "deleted_at" TEXT,
  "rev" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("id")
);

CREATE INDEX suggestions_lookup_0 ON suggestions (user_id, day, status);

CREATE TABLE runs (
  "id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "day" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "started_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "finished_at" TEXT,
  "stats" TEXT NOT NULL DEFAULT '{}',
  "error" TEXT,
  "rev" INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY ("id")
);

CREATE INDEX runs_lookup_0 ON runs (day, kind);

CREATE INDEX runs_lookup_1 ON runs (status);

CREATE TABLE sync_cursors (
  "name" TEXT NOT NULL,
  "value" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY ("name")
);

CREATE TABLE api_tokens (
  "id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "hash" TEXT NOT NULL,
  "scopes" TEXT NOT NULL,
  "created_at" TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  "last_used_at" TEXT,
  "expires_at" TEXT,
  "revoked_at" TEXT,
  PRIMARY KEY ("id")
);

CREATE INDEX api_tokens_lookup_0 ON api_tokens (revoked_at);

CREATE TABLE trend_snapshots (
  "topic_id" TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE ON UPDATE CASCADE,
  "period" TEXT NOT NULL,
  "paper_count" INTEGER NOT NULL,
  "top_paper_ids" TEXT NOT NULL DEFAULT '[]',
  "summary_md" TEXT,
  "computed_at" TEXT NOT NULL,
  PRIMARY KEY ("topic_id", "period")
);

CREATE INDEX trend_snapshots_lookup_0 ON trend_snapshots (period);

CREATE UNIQUE INDEX paper_links_unique ON paper_links(paper_id,kind,url);
CREATE UNIQUE INDEX api_tokens_hash ON api_tokens(hash);
CREATE UNIQUE INDEX profile_docs_unique ON profile_docs(user_id,path);
CREATE UNIQUE INDEX projects_unique ON projects(user_id,slug);
