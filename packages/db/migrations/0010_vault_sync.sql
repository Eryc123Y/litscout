CREATE TABLE vault_notes (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('project', 'idea', 'working_paper', 'paper_note', 'brief')),
  title TEXT NOT NULL,
  frontmatter TEXT NOT NULL,
  hash TEXT NOT NULL,
  body_hash TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE INDEX vault_notes_kind ON vault_notes(kind, id) WHERE deleted_at IS NULL;
CREATE INDEX vault_notes_arxiv ON vault_notes(json_extract(frontmatter, '$.arxiv'))
  WHERE kind = 'paper_note' AND deleted_at IS NULL;
CREATE INDEX vault_notes_doi ON vault_notes(json_extract(frontmatter, '$.doi'))
  WHERE kind = 'paper_note' AND deleted_at IS NULL;

ALTER TABLE projects ADD COLUMN vault_note_id TEXT REFERENCES vault_notes(id);
CREATE UNIQUE INDEX projects_vault_note ON projects(vault_note_id);

CREATE TABLE idea_index (
  id TEXT PRIMARY KEY,
  vault_note_id TEXT NOT NULL REFERENCES vault_notes(id),
  title TEXT NOT NULL,
  status TEXT,
  description TEXT,
  project_id TEXT REFERENCES projects(id),
  paper_ids TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);
CREATE INDEX idea_index_project ON idea_index(project_id);

CREATE TABLE working_paper_index (
  id TEXT PRIMARY KEY,
  vault_note_id TEXT NOT NULL REFERENCES vault_notes(id),
  title TEXT NOT NULL,
  status TEXT,
  project_id TEXT REFERENCES projects(id),
  idea_ids TEXT NOT NULL DEFAULT '[]',
  paper_ids TEXT NOT NULL DEFAULT '[]',
  updated_at TEXT NOT NULL
);

CREATE TABLE vault_requests (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('capture', 'link_paper', 'set_status', 'add_reading', 'make_paper_note')),
  target_note_id TEXT REFERENCES vault_notes(id),
  payload TEXT NOT NULL,
  base_hash TEXT,
  state TEXT NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'applied', 'rejected', 'cancelled')),
  reason TEXT,
  origin TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolved_at TEXT,
  result_hash TEXT,
  claim TEXT,
  claim_until TEXT
);
CREATE INDEX vault_requests_queue ON vault_requests(state, created_at, id);
CREATE INDEX vault_requests_resolved ON vault_requests(state, resolved_at DESC);
CREATE UNIQUE INDEX vault_requests_make ON vault_requests(json_extract(payload, '$.paperId'))
  WHERE kind = 'make_paper_note' AND state = 'queued';

CREATE TABLE captures (
  id TEXT PRIMARY KEY REFERENCES vault_requests(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL DEFAULT 'u_owner',
  title TEXT NOT NULL,
  body_md TEXT NOT NULL DEFAULT '',
  source_paper_id TEXT,
  suggestion_id TEXT,
  created_at TEXT NOT NULL,
  handed_off_at TEXT
);

CREATE TABLE vault_sync (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  snapshot TEXT,
  publish_token TEXT,
  note_count INTEGER NOT NULL DEFAULT 0,
  report TEXT,
  reported_at TEXT
);
INSERT INTO vault_sync(id) VALUES (1);

-- One bounded slot per batch number. The live index changes only at publication.
CREATE TABLE vault_index_parts (
  part INTEGER PRIMARY KEY,
  snapshot TEXT NOT NULL,
  notes TEXT NOT NULL,
  removed TEXT NOT NULL
);

CREATE VIEW vault_staged_notes AS
SELECT part, snapshot, value ->> 'id' AS id, value ->> 'path' AS path,
       value ->> 'kind' AS kind, value ->> 'title' AS title, value -> 'frontmatter' AS frontmatter,
       value ->> 'hash' AS hash, value ->> 'bodyHash' AS body_hash, value ->> 'fingerprint' AS fingerprint
FROM vault_index_parts, json_each(notes);

CREATE VIEW vault_staged_removals AS
SELECT part, snapshot, value AS id FROM vault_index_parts, json_each(removed);

CREATE VIEW vault_identifiers AS
SELECT scheme, value, paper_id FROM paper_ids WHERE scheme IN ('arxiv', 'doi')
UNION ALL SELECT 'arxiv', arxiv_id, paper_id FROM paper_index idx WHERE arxiv_id IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM paper_ids WHERE scheme='arxiv' AND value=idx.arxiv_id)
UNION ALL SELECT 'doi', doi, paper_id FROM paper_index idx WHERE doi IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM paper_ids WHERE scheme='doi' AND value=idx.doi);

-- A disagreement between DOI and arXiv matches leaves the note untouched.
CREATE VIEW vault_paper_matches AS
WITH matches AS (
  SELECT n.id, n.path, i.paper_id FROM vault_notes n JOIN vault_identifiers i
    ON i.scheme = 'arxiv' AND i.value = json_extract(n.frontmatter, '$.arxiv')
  WHERE n.kind = 'paper_note' AND n.deleted_at IS NULL
  UNION ALL
  SELECT n.id, n.path, i.paper_id FROM vault_notes n JOIN vault_identifiers i
    ON i.scheme = 'doi' AND i.value = json_extract(n.frontmatter, '$.doi')
  WHERE n.kind = 'paper_note' AND n.deleted_at IS NULL
)
SELECT id,path,min(paper_id) AS paper_id FROM matches GROUP BY id,path HAVING count(DISTINCT paper_id)=1;

UPDATE litscout_schema SET version=9;
