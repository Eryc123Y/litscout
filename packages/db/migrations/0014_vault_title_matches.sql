ALTER TABLE papers ADD COLUMN vault_title_norm TEXT;
CREATE INDEX papers_vault_title_norm ON papers(vault_title_norm, deleted_at, id);

ALTER TABLE paper_index ADD COLUMN title_norm TEXT;
ALTER TABLE paper_index ADD COLUMN has_canonical INTEGER NOT NULL DEFAULT 0;
UPDATE paper_index SET has_canonical=1
  WHERE EXISTS(SELECT 1 FROM papers WHERE id=paper_index.paper_id);

-- Separate compact-only rows in the title index so even an ambiguous title
-- with many superseded copies needs at most two candidate reads.
CREATE INDEX paper_index_title_norm ON paper_index(title_norm, has_canonical, paper_id);

CREATE TRIGGER paper_index_canonical_insert AFTER INSERT ON paper_index
WHEN NEW.has_canonical=0 AND EXISTS(SELECT 1 FROM papers WHERE id=NEW.paper_id)
BEGIN
  UPDATE paper_index SET has_canonical=1 WHERE paper_id=NEW.paper_id;
END;
CREATE TRIGGER paper_index_canonical_move AFTER UPDATE OF paper_id ON paper_index
WHEN NEW.paper_id IS NOT OLD.paper_id
BEGIN
  UPDATE paper_index SET has_canonical=EXISTS(SELECT 1 FROM papers WHERE id=NEW.paper_id)
    WHERE paper_id=NEW.paper_id;
END;
CREATE TRIGGER papers_compact_insert AFTER INSERT ON papers
BEGIN
  UPDATE paper_index SET has_canonical=1 WHERE paper_id=NEW.id AND has_canonical=0;
END;
CREATE TRIGGER papers_compact_delete AFTER DELETE ON papers
BEGIN
  UPDATE paper_index SET has_canonical=0 WHERE paper_id=OLD.id AND has_canonical=1;
END;
CREATE TRIGGER papers_compact_move AFTER UPDATE OF id ON papers
WHEN NEW.id IS NOT OLD.id
BEGIN
  UPDATE paper_index SET has_canonical=0 WHERE paper_id=OLD.id AND has_canonical=1;
  UPDATE paper_index SET has_canonical=1 WHERE paper_id=NEW.id AND has_canonical=0;
END;

ALTER TABLE vault_notes ADD COLUMN title_norm TEXT;
ALTER TABLE vault_notes ADD COLUMN title_paper_id TEXT;
CREATE INDEX vault_notes_title_paper ON vault_notes(title_paper_id, path)
  WHERE title_paper_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX vault_notes_unkeyed_title ON vault_notes(id)
  WHERE kind='paper_note' AND deleted_at IS NULL AND title_norm IS NULL
    AND json_extract(frontmatter,'$.arxiv') IS NULL
    AND json_extract(frontmatter,'$.doi') IS NULL;

DROP VIEW vault_staged_notes;
CREATE VIEW vault_staged_notes AS
SELECT part, snapshot, value ->> 'id' AS id, value ->> 'path' AS path,
       value ->> 'kind' AS kind, value ->> 'title' AS title, value -> 'frontmatter' AS frontmatter,
       value ->> 'hash' AS hash, value ->> 'bodyHash' AS body_hash, value ->> 'fingerprint' AS fingerprint,
       value ->> 'titleNorm' AS title_norm
FROM vault_index_parts, json_each(notes);

-- Legacy keys begin as NULL and are filled in bounded batches by vault sync.
-- Sync uses the same Unicode folding for legacy titles and new titles.
UPDATE litscout_schema SET version=13;
