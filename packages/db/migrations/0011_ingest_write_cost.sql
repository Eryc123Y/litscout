-- The unique (paper_id, kind, url) index serves paper lookups.
-- The (user_id, checked_at, id) index serves the link-check queue.
DROP INDEX paper_links_lookup_0;
DROP INDEX paper_links_lookup_1;

-- Other paper metadata does not change the indexed search document.
DROP TRIGGER paper_fts_update;
CREATE TRIGGER paper_fts_update AFTER UPDATE ON papers
WHEN OLD.rowid IS NOT NEW.rowid OR OLD.title IS NOT NEW.title OR OLD.tldr IS NOT NEW.tldr
BEGIN
 INSERT INTO paper_fts(paper_fts, rowid, title, tldr) VALUES ('delete', old.rowid, old.title, old.tldr);
 INSERT INTO paper_fts(rowid, title, tldr) VALUES (new.rowid, new.title, new.tldr);
END;

UPDATE litscout_schema SET version=10;
