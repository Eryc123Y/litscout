CREATE VIRTUAL TABLE paper_fts USING fts5(title, tldr, content='papers', content_rowid='rowid', detail=column, columnsize=0);
CREATE TRIGGER paper_fts_insert AFTER INSERT ON papers BEGIN
 INSERT INTO paper_fts(rowid, title, tldr) VALUES (new.rowid, new.title, new.tldr);
END;
CREATE TRIGGER paper_fts_delete AFTER DELETE ON papers BEGIN
 INSERT INTO paper_fts(paper_fts, rowid, title, tldr) VALUES ('delete', old.rowid, old.title, old.tldr);
END;
CREATE TRIGGER paper_fts_update AFTER UPDATE ON papers BEGIN
 INSERT INTO paper_fts(paper_fts, rowid, title, tldr) VALUES ('delete', old.rowid, old.title, old.tldr);
 INSERT INTO paper_fts(rowid, title, tldr) VALUES (new.rowid, new.title, new.tldr);
END;

CREATE VIRTUAL TABLE note_fts USING fts5(body_md, content='notes', content_rowid='rowid', detail=column, columnsize=0);
CREATE TRIGGER note_fts_insert AFTER INSERT ON notes BEGIN
 INSERT INTO note_fts(rowid, body_md) VALUES (new.rowid, new.body_md);
END;
CREATE TRIGGER note_fts_delete AFTER DELETE ON notes BEGIN
 INSERT INTO note_fts(note_fts, rowid, body_md) VALUES ('delete', old.rowid, old.body_md);
END;
CREATE TRIGGER note_fts_update AFTER UPDATE ON notes BEGIN
 INSERT INTO note_fts(note_fts, rowid, body_md) VALUES ('delete', old.rowid, old.body_md);
 INSERT INTO note_fts(rowid, body_md) VALUES (new.rowid, new.body_md);
END;

CREATE VIRTUAL TABLE idea_fts USING fts5(title, body_md, content='ideas', content_rowid='rowid', detail=column, columnsize=0);
CREATE TRIGGER idea_fts_insert AFTER INSERT ON ideas BEGIN
 INSERT INTO idea_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
END;
CREATE TRIGGER idea_fts_delete AFTER DELETE ON ideas BEGIN
 INSERT INTO idea_fts(idea_fts, rowid, title, body_md) VALUES ('delete', old.rowid, old.title, old.body_md);
END;
CREATE TRIGGER idea_fts_update AFTER UPDATE ON ideas BEGIN
 INSERT INTO idea_fts(idea_fts, rowid, title, body_md) VALUES ('delete', old.rowid, old.title, old.body_md);
 INSERT INTO idea_fts(rowid, title, body_md) VALUES (new.rowid, new.title, new.body_md);
END;

CREATE TRIGGER summary_tldr_insert AFTER INSERT ON summaries BEGIN
 UPDATE papers SET tldr = coalesce((SELECT json_extract(content, '$.tldr') FROM summaries WHERE paper_id=new.paper_id ORDER BY lang='en' DESC, created_at DESC LIMIT 1), '') WHERE id=new.paper_id;
END;

CREATE TRIGGER summary_tldr_update AFTER UPDATE ON summaries BEGIN
 UPDATE papers SET tldr = coalesce((SELECT json_extract(content, '$.tldr') FROM summaries WHERE paper_id=new.paper_id ORDER BY lang='en' DESC, created_at DESC LIMIT 1), '') WHERE id=new.paper_id;
END;

CREATE TRIGGER summary_tldr_delete AFTER DELETE ON summaries BEGIN
 UPDATE papers SET tldr = coalesce((SELECT json_extract(content, '$.tldr') FROM summaries WHERE paper_id=old.paper_id ORDER BY lang='en' DESC, created_at DESC LIMIT 1), '') WHERE id=old.paper_id;
END;

CREATE TABLE litscout_schema (version INTEGER PRIMARY KEY);
INSERT INTO litscout_schema(version) VALUES (1);
