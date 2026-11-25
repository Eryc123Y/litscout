-- These indexes have no read callers. The keyword order already covers (day, shortlisted).
DROP INDEX papers_lookup_1;
DROP INDEX papers_lookup_2;
DROP INDEX paper_index_lookup_0;
DROP INDEX paper_index_lookup_3;
DROP INDEX feed_items_lookup_1;

-- Store identifier rows in the unique key's B-tree. Value-first also serves
-- the unqualified identifier lookup, so it needs no second value index.
CREATE TABLE m3i_paper_ids (
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  scheme TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (value, scheme)
) WITHOUT ROWID;
INSERT INTO m3i_paper_ids(paper_id,scheme,value)
  SELECT paper_id,scheme,value FROM paper_ids;
DROP VIEW vault_paper_matches;
DROP VIEW vault_identifiers;
DROP TABLE paper_ids;
ALTER TABLE m3i_paper_ids RENAME TO paper_ids;
CREATE INDEX paper_ids_backup_key ON paper_ids(paper_id,scheme,value);

CREATE VIEW vault_identifiers AS
SELECT scheme, value, paper_id FROM paper_ids WHERE scheme IN ('arxiv', 'doi')
UNION ALL SELECT 'arxiv', arxiv_id, paper_id FROM paper_index idx WHERE arxiv_id IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM paper_ids WHERE scheme='arxiv' AND value=idx.arxiv_id)
UNION ALL SELECT 'doi', doi, paper_id FROM paper_index idx WHERE doi IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM paper_ids WHERE scheme='doi' AND value=idx.doi);

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

-- Keep the link ID, attributes and both read indexes, without duplicating the
-- ID in a separate primary-key index.
CREATE TABLE m3i_paper_links (
  id TEXT NOT NULL PRIMARY KEY,
  paper_id TEXT NOT NULL REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  kind TEXT NOT NULL,
  url TEXT NOT NULL,
  licence TEXT,
  oa_status TEXT NOT NULL DEFAULT 'unknown',
  source TEXT NOT NULL DEFAULT 'manual',
  checked_at TEXT,
  http_status INTEGER,
  user_id TEXT NOT NULL DEFAULT 'u_owner'
) WITHOUT ROWID;
INSERT INTO m3i_paper_links(id,paper_id,kind,url,licence,oa_status,source,checked_at,http_status,user_id)
  SELECT id,paper_id,kind,url,licence,oa_status,source,checked_at,http_status,user_id FROM paper_links;
DROP TABLE paper_links;
ALTER TABLE m3i_paper_links RENAME TO paper_links;
CREATE UNIQUE INDEX paper_links_unique ON paper_links(paper_id,kind,url);
CREATE INDEX paper_links_check_queue ON paper_links(user_id,checked_at,id);

UPDATE litscout_schema SET version=16;
