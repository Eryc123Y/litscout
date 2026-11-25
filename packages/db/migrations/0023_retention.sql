-- Feed occurrences are historical data and can point at either representation.
-- Copy before installing the triggers so existing counters are untouched.

DROP TRIGGER feed_counts_insert;

DROP TRIGGER feed_counts_delete;

DROP TRIGGER feed_counts_update;

DROP TRIGGER feed_counts_paper;

DROP TRIGGER feed_counts_paper_delete;

DROP TRIGGER feed_counts_summary_insert;

DROP TRIGGER feed_counts_summary_delete;

DROP TRIGGER feed_counts_summary_move_old;

DROP TRIGGER feed_counts_summary_move_new;

CREATE TABLE retention_feed_items (
  day TEXT NOT NULL REFERENCES feed_days(day) ON DELETE CASCADE ON UPDATE CASCADE,
  paper_id TEXT NOT NULL,
  source TEXT NOT NULL,
  rank_in_source INTEGER,
  hf_upvotes INTEGER,
  topics TEXT NOT NULL DEFAULT '[]',
  shortlisted INTEGER NOT NULL DEFAULT 0,
  rev INTEGER NOT NULL DEFAULT 1,
  rank_sort INTEGER GENERATED ALWAYS AS (coalesce(rank_in_source,-1)) VIRTUAL,
  PRIMARY KEY(day,paper_id,source)
);
INSERT INTO retention_feed_items(day,paper_id,source,rank_in_source,hf_upvotes,topics,shortlisted,rev)
  SELECT day,paper_id,source,rank_in_source,hf_upvotes,topics,shortlisted,rev FROM feed_items;
DROP TABLE feed_items;
ALTER TABLE retention_feed_items RENAME TO feed_items;
CREATE INDEX feed_items_lookup_0 ON feed_items(paper_id,day);
CREATE INDEX feed_items_read_order ON feed_items(day,rank_sort,paper_id,source);
CREATE INDEX feed_items_keyword_read_order ON feed_items(day,shortlisted DESC,rank_sort,paper_id,source);

CREATE TRIGGER feed_paper_insert BEFORE INSERT ON feed_items
WHEN NOT EXISTS(SELECT 1 FROM papers WHERE id=NEW.paper_id)
 AND NOT EXISTS(SELECT 1 FROM paper_index WHERE paper_id=NEW.paper_id AND has_canonical=0) BEGIN
  SELECT RAISE(ABORT,'feed paper missing');
END;

CREATE TRIGGER feed_paper_move BEFORE UPDATE OF paper_id ON feed_items
WHEN NOT EXISTS(SELECT 1 FROM papers WHERE id=NEW.paper_id)
 AND NOT EXISTS(SELECT 1 FROM paper_index WHERE paper_id=NEW.paper_id AND has_canonical=0) BEGIN
  SELECT RAISE(ABORT,'feed paper missing');
END;

CREATE INDEX papers_retention_age ON papers(coalesce(first_seen_on,substr(created_at,1,10)),id)
  WHERE deleted_at IS NULL;
CREATE INDEX notes_retention_paper ON notes(target_id) WHERE target_type='paper';
CREATE INDEX vault_notes_retention_title ON vault_notes(title_norm)
  WHERE kind='paper_note' AND deleted_at IS NULL;
DROP INDEX vault_notes_arxiv;
DROP INDEX vault_notes_doi;
CREATE INDEX vault_notes_arxiv ON vault_notes(lower(json_extract(frontmatter,'$.arxiv')))
  WHERE kind='paper_note' AND deleted_at IS NULL;
CREATE INDEX vault_notes_doi ON vault_notes(lower(json_extract(frontmatter,'$.doi')))
  WHERE kind='paper_note' AND deleted_at IS NULL;
CREATE INDEX captures_retention_paper ON captures(source_paper_id);
CREATE INDEX vault_requests_retention_paper ON vault_requests(json_extract(payload,'$.paperId'));

-- Arrays in published records are mirrored as reverse references. Keep the
-- source row in the key so removing one link never unprotects another.
CREATE TABLE retention_refs (
  paper_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_key TEXT NOT NULL,
  PRIMARY KEY(paper_id,source,source_key)
) WITHOUT ROWID;
CREATE INDEX retention_refs_source ON retention_refs(source,source_key);

CREATE VIRTUAL TABLE compact_paper_fts USING fts5(
  title, content='', contentless_delete=1, detail=column
);
INSERT INTO compact_paper_fts(rowid,title) SELECT rowid,title FROM paper_index WHERE has_canonical=0;
CREATE TRIGGER compact_fts_insert AFTER INSERT ON paper_index BEGIN
  INSERT INTO compact_paper_fts(rowid,title)
    SELECT NEW.rowid,NEW.title WHERE NEW.has_canonical=0
      AND NOT EXISTS(SELECT 1 FROM papers WHERE id=NEW.paper_id);
END;
CREATE TRIGGER compact_fts_delete AFTER DELETE ON paper_index
WHEN OLD.has_canonical=0 BEGIN
  DELETE FROM compact_paper_fts WHERE rowid=OLD.rowid;
END;
CREATE TRIGGER compact_fts_update AFTER UPDATE OF title,has_canonical ON paper_index
WHEN (OLD.has_canonical=0 OR NEW.has_canonical=0)
 AND (OLD.has_canonical IS NOT NEW.has_canonical OR OLD.title IS NOT NEW.title) BEGIN
  DELETE FROM compact_paper_fts WHERE rowid=OLD.rowid AND OLD.has_canonical=0;
  INSERT INTO compact_paper_fts(rowid,title)
    SELECT NEW.rowid,NEW.title WHERE NEW.has_canonical=0;
END;

CREATE TRIGGER feed_counts_insert AFTER INSERT ON feed_items BEGIN
  INSERT INTO feed_read_counts(day,kind,key,n)
  SELECT day,kind,key,1*sum(n) FROM (WITH live AS MATERIALIZED (SELECT NEW.day AS day,NEW.source AS source,NEW.topics AS topics,NEW.shortlisted AS shortlisted,coalesce(p.venue,i.venue) AS venue,
      (p.id IS NOT NULL AND (p.abstract IS NULL OR trim(p.abstract,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))='')) AS no_abstract,
      EXISTS(SELECT 1 FROM summaries WHERE paper_id=p.id) AS summarised
      FROM (SELECT NEW.paper_id AS id) ref LEFT JOIN papers p ON p.id=ref.id LEFT JOIN paper_index i ON i.paper_id=ref.id AND p.id IS NULL AND i.has_canonical=0 WHERE p.deleted_at IS NULL AND (p.id IS NOT NULL OR i.paper_id IS NOT NULL))
    SELECT day,json_extract(j.value,'$[0]') AS kind,json_extract(j.value,'$[1]') AS key,json_extract(j.value,'$[2]') AS n
    FROM live,json_each(json_array(
      json_array('total','',1),json_array('sources',source,1),
      json_array('venueCounts',coalesce(venue,''),venue IS NOT NULL),
      json_array('shortlisted','',shortlisted),json_array('summarised','',summarised),json_array('noAbstract','',no_abstract))) j
    UNION ALL SELECT day,'topics',j.value,1 FROM live,json_each(live.topics) j) WHERE n<>0 GROUP BY day,kind,key
  ON CONFLICT(day,kind,key) DO UPDATE SET n=n+excluded.n;
END;

CREATE TRIGGER feed_counts_delete AFTER DELETE ON feed_items BEGIN
  INSERT INTO feed_read_counts(day,kind,key,n)
  SELECT day,kind,key,-1*sum(n) FROM (WITH live AS MATERIALIZED (SELECT OLD.day AS day,OLD.source AS source,OLD.topics AS topics,OLD.shortlisted AS shortlisted,coalesce(p.venue,i.venue) AS venue,
      (p.id IS NOT NULL AND (p.abstract IS NULL OR trim(p.abstract,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))='')) AS no_abstract,
      EXISTS(SELECT 1 FROM summaries WHERE paper_id=p.id) AS summarised
      FROM (SELECT OLD.paper_id AS id) ref LEFT JOIN papers p ON p.id=ref.id LEFT JOIN paper_index i ON i.paper_id=ref.id AND p.id IS NULL AND i.has_canonical=0 WHERE p.deleted_at IS NULL AND (p.id IS NOT NULL OR i.paper_id IS NOT NULL) AND EXISTS(SELECT 1 FROM feed_days WHERE day=OLD.day))
    SELECT day,json_extract(j.value,'$[0]') AS kind,json_extract(j.value,'$[1]') AS key,json_extract(j.value,'$[2]') AS n
    FROM live,json_each(json_array(
      json_array('total','',1),json_array('sources',source,1),
      json_array('venueCounts',coalesce(venue,''),venue IS NOT NULL),
      json_array('shortlisted','',shortlisted),json_array('summarised','',summarised),json_array('noAbstract','',no_abstract))) j
    UNION ALL SELECT day,'topics',j.value,1 FROM live,json_each(live.topics) j) WHERE n<>0 GROUP BY day,kind,key
  ON CONFLICT(day,kind,key) DO UPDATE SET n=n+excluded.n;
END;

CREATE TRIGGER feed_counts_update AFTER UPDATE OF day,paper_id,source,topics,shortlisted ON feed_items
WHEN (OLD.day IS NOT NEW.day OR OLD.paper_id IS NOT NEW.paper_id OR OLD.source IS NOT NEW.source
 OR OLD.topics IS NOT NEW.topics OR OLD.shortlisted IS NOT NEW.shortlisted)
 AND EXISTS(SELECT 1 FROM feed_days WHERE day=OLD.day)
 BEGIN
  INSERT INTO feed_read_counts(day,kind,key,n)
  SELECT day,kind,key,-1*sum(n) FROM (WITH live AS MATERIALIZED (SELECT OLD.day AS day,OLD.source AS source,OLD.topics AS topics,OLD.shortlisted AS shortlisted,coalesce(p.venue,i.venue) AS venue,
      (p.id IS NOT NULL AND (p.abstract IS NULL OR trim(p.abstract,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))='')) AS no_abstract,
      EXISTS(SELECT 1 FROM summaries WHERE paper_id=p.id) AS summarised
      FROM (SELECT OLD.paper_id AS id) ref LEFT JOIN papers p ON p.id=ref.id LEFT JOIN paper_index i ON i.paper_id=ref.id AND p.id IS NULL AND i.has_canonical=0 WHERE p.deleted_at IS NULL AND (p.id IS NOT NULL OR i.paper_id IS NOT NULL) AND EXISTS(SELECT 1 FROM feed_days WHERE day=OLD.day))
    SELECT day,json_extract(j.value,'$[0]') AS kind,json_extract(j.value,'$[1]') AS key,json_extract(j.value,'$[2]') AS n
    FROM live,json_each(json_array(
      json_array('total','',1),json_array('sources',source,1),
      json_array('venueCounts',coalesce(venue,''),venue IS NOT NULL),
      json_array('shortlisted','',shortlisted),json_array('summarised','',summarised),json_array('noAbstract','',no_abstract))) j
    UNION ALL SELECT day,'topics',j.value,1 FROM live,json_each(live.topics) j) WHERE n<>0 GROUP BY day,kind,key
  ON CONFLICT(day,kind,key) DO UPDATE SET n=n+excluded.n;
  INSERT INTO feed_read_counts(day,kind,key,n)
  SELECT day,kind,key,1*sum(n) FROM (WITH live AS MATERIALIZED (SELECT NEW.day AS day,NEW.source AS source,NEW.topics AS topics,NEW.shortlisted AS shortlisted,coalesce(p.venue,i.venue) AS venue,
      (p.id IS NOT NULL AND (p.abstract IS NULL OR trim(p.abstract,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))='')) AS no_abstract,
      EXISTS(SELECT 1 FROM summaries WHERE paper_id=p.id) AS summarised
      FROM (SELECT NEW.paper_id AS id) ref LEFT JOIN papers p ON p.id=ref.id LEFT JOIN paper_index i ON i.paper_id=ref.id AND p.id IS NULL AND i.has_canonical=0 WHERE p.deleted_at IS NULL AND (p.id IS NOT NULL OR i.paper_id IS NOT NULL))
    SELECT day,json_extract(j.value,'$[0]') AS kind,json_extract(j.value,'$[1]') AS key,json_extract(j.value,'$[2]') AS n
    FROM live,json_each(json_array(
      json_array('total','',1),json_array('sources',source,1),
      json_array('venueCounts',coalesce(venue,''),venue IS NOT NULL),
      json_array('shortlisted','',shortlisted),json_array('summarised','',summarised),json_array('noAbstract','',no_abstract))) j
    UNION ALL SELECT day,'topics',j.value,1 FROM live,json_each(live.topics) j) WHERE n<>0 GROUP BY day,kind,key
  ON CONFLICT(day,kind,key) DO UPDATE SET n=n+excluded.n;
END;

CREATE TRIGGER feed_counts_paper AFTER UPDATE OF abstract,venue,deleted_at ON papers
WHEN (OLD.abstract IS NULL OR trim(OLD.abstract,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))='') IS NOT (NEW.abstract IS NULL OR trim(NEW.abstract,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))='')
 OR OLD.venue IS NOT NEW.venue OR OLD.deleted_at IS NOT NEW.deleted_at BEGIN
  INSERT INTO feed_read_counts(day,kind,key,n)
  SELECT day,kind,key,-1*sum(n) FROM (WITH live AS MATERIALIZED (SELECT f.day,f.source,f.topics,f.shortlisted,OLD.venue AS venue,
      (OLD.abstract IS NULL OR trim(OLD.abstract,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))='') AS no_abstract,
      EXISTS(SELECT 1 FROM summaries WHERE paper_id=OLD.id) AS summarised
      FROM feed_items f WHERE f.paper_id=OLD.id AND OLD.deleted_at IS NULL)
    SELECT day,json_extract(j.value,'$[0]') AS kind,json_extract(j.value,'$[1]') AS key,json_extract(j.value,'$[2]') AS n
    FROM live,json_each(json_array(
      json_array('total','',1),json_array('sources',source,1),
      json_array('venueCounts',coalesce(venue,''),venue IS NOT NULL),
      json_array('shortlisted','',shortlisted),json_array('summarised','',summarised),json_array('noAbstract','',no_abstract))) j
    UNION ALL SELECT day,'topics',j.value,1 FROM live,json_each(live.topics) j) WHERE n<>0 GROUP BY day,kind,key
  ON CONFLICT(day,kind,key) DO UPDATE SET n=n+excluded.n;
  INSERT INTO feed_read_counts(day,kind,key,n)
  SELECT day,kind,key,1*sum(n) FROM (WITH live AS MATERIALIZED (SELECT f.day,f.source,f.topics,f.shortlisted,NEW.venue AS venue,
      (NEW.abstract IS NULL OR trim(NEW.abstract,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))='') AS no_abstract,
      EXISTS(SELECT 1 FROM summaries WHERE paper_id=NEW.id) AS summarised
      FROM feed_items f WHERE f.paper_id=NEW.id AND NEW.deleted_at IS NULL)
    SELECT day,json_extract(j.value,'$[0]') AS kind,json_extract(j.value,'$[1]') AS key,json_extract(j.value,'$[2]') AS n
    FROM live,json_each(json_array(
      json_array('total','',1),json_array('sources',source,1),
      json_array('venueCounts',coalesce(venue,''),venue IS NOT NULL),
      json_array('shortlisted','',shortlisted),json_array('summarised','',summarised),json_array('noAbstract','',no_abstract))) j
    UNION ALL SELECT day,'topics',j.value,1 FROM live,json_each(live.topics) j) WHERE n<>0 GROUP BY day,kind,key
  ON CONFLICT(day,kind,key) DO UPDATE SET n=n+excluded.n;
END;

CREATE TRIGGER feed_counts_restore AFTER INSERT ON papers
WHEN EXISTS(SELECT 1 FROM feed_items WHERE paper_id=NEW.id) BEGIN
  INSERT INTO feed_read_counts(day,kind,key,n)
    SELECT day,'noAbstract','',count(*) FROM feed_items
    WHERE paper_id=NEW.id AND (NEW.abstract IS NULL OR trim(NEW.abstract,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))='') GROUP BY day
    ON CONFLICT(day,kind,key) DO UPDATE SET n=n+excluded.n;
  INSERT INTO feed_read_counts(day,kind,key,n)
    SELECT f.day,'venueCounts',v.key,v.direction*count(*)
    FROM feed_items f JOIN paper_index i ON i.paper_id=f.paper_id
    JOIN (SELECT NEW.venue AS key,1 AS direction UNION ALL
      SELECT venue,-1 FROM paper_index WHERE paper_id=NEW.id) v
    WHERE f.paper_id=NEW.id AND NEW.venue IS NOT i.venue AND v.key IS NOT NULL
    GROUP BY f.day,v.key,v.direction
    ON CONFLICT(day,kind,key) DO UPDATE SET n=n+excluded.n;
END;

CREATE TRIGGER feed_counts_paper_delete BEFORE DELETE ON papers BEGIN
  DELETE FROM feed_items WHERE paper_id=OLD.id
    AND NOT EXISTS(SELECT 1 FROM paper_index WHERE paper_id=OLD.id AND has_canonical=0);
  UPDATE feed_read_counts SET n=n-(
    SELECT count(*) FROM feed_items WHERE paper_id=OLD.id AND day=feed_read_counts.day
  )
  WHERE kind='noAbstract' AND key='' AND (OLD.abstract IS NULL OR trim(OLD.abstract,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))='')
    AND day IN (SELECT day FROM feed_items WHERE paper_id=OLD.id)
    AND EXISTS(SELECT 1 FROM paper_index WHERE paper_id=OLD.id AND has_canonical=0);
END;

CREATE TRIGGER feed_counts_summary_insert AFTER INSERT ON summaries
WHEN (SELECT count(*) FROM summaries WHERE paper_id=NEW.paper_id)=1 BEGIN
  INSERT INTO feed_read_counts(day,kind,key,n)
  SELECT f.day,'summarised','',1*count(*) FROM feed_items f JOIN papers p ON p.id=f.paper_id
  WHERE f.paper_id=NEW.paper_id AND p.deleted_at IS NULL GROUP BY f.day
  ON CONFLICT(day,kind,key) DO UPDATE SET n=n+excluded.n;
END;

CREATE TRIGGER feed_counts_summary_delete AFTER DELETE ON summaries
WHEN NOT EXISTS(SELECT 1 FROM summaries WHERE paper_id=OLD.paper_id) BEGIN
  INSERT INTO feed_read_counts(day,kind,key,n)
  SELECT f.day,'summarised','',-1*count(*) FROM feed_items f JOIN papers p ON p.id=f.paper_id
  WHERE f.paper_id=OLD.paper_id AND p.deleted_at IS NULL GROUP BY f.day
  ON CONFLICT(day,kind,key) DO UPDATE SET n=n+excluded.n;
END;

CREATE TRIGGER feed_counts_summary_move_old AFTER UPDATE OF paper_id ON summaries
WHEN OLD.paper_id IS NOT NEW.paper_id AND EXISTS(SELECT 1 FROM papers WHERE id=OLD.paper_id) AND NOT EXISTS(SELECT 1 FROM summaries WHERE paper_id=OLD.paper_id) BEGIN
  INSERT INTO feed_read_counts(day,kind,key,n)
  SELECT f.day,'summarised','',-1*count(*) FROM feed_items f JOIN papers p ON p.id=f.paper_id
  WHERE f.paper_id=OLD.paper_id AND p.deleted_at IS NULL GROUP BY f.day
  ON CONFLICT(day,kind,key) DO UPDATE SET n=n+excluded.n;
END;

CREATE TRIGGER feed_counts_summary_move_new AFTER UPDATE OF paper_id ON summaries
WHEN OLD.paper_id IS NOT NEW.paper_id AND EXISTS(SELECT 1 FROM papers WHERE id=NEW.paper_id) AND (SELECT count(*) FROM summaries WHERE paper_id=NEW.paper_id)=1 BEGIN
  INSERT INTO feed_read_counts(day,kind,key,n)
  SELECT f.day,'summarised','',1*count(*) FROM feed_items f JOIN papers p ON p.id=f.paper_id
  WHERE f.paper_id=NEW.paper_id AND p.deleted_at IS NULL GROUP BY f.day
  ON CONFLICT(day,kind,key) DO UPDATE SET n=n+excluded.n;
END;

INSERT OR IGNORE INTO retention_refs(paper_id,source,source_key)
  SELECT paper_id,'digests',source_key FROM (SELECT j.value AS paper_id,d.day_key AS source_key FROM (SELECT json_array(day,lang,kind) AS day_key,picks,radar FROM digests) d,json_each(d.picks) j WHERE j.type='text'
  UNION SELECT j.value->>'paperId',json_array(d.day,d.lang,d.kind) FROM digests d,json_each(d.radar) j
    WHERE j.type='object' AND j.value->>'paperId' IS NOT NULL);
CREATE TRIGGER retention_digests_insert AFTER INSERT ON digests BEGIN
  INSERT OR IGNORE INTO retention_refs(paper_id,source,source_key)
    SELECT paper_id,'digests',json_array(NEW.day,NEW.lang,NEW.kind) FROM (SELECT value AS paper_id FROM json_each(NEW.picks) WHERE type='text' UNION SELECT value->>'paperId' FROM json_each(NEW.radar) WHERE type='object') WHERE paper_id IS NOT NULL;
END;
CREATE TRIGGER retention_digests_update AFTER UPDATE OF picks,radar ON digests
WHEN OLD.picks IS NOT NEW.picks OR OLD.radar IS NOT NEW.radar BEGIN
  DELETE FROM retention_refs WHERE source='digests' AND source_key=json_array(OLD.day,OLD.lang,OLD.kind)
    AND paper_id NOT IN (SELECT paper_id FROM (SELECT value AS paper_id FROM json_each(NEW.picks) WHERE type='text' UNION SELECT value->>'paperId' FROM json_each(NEW.radar) WHERE type='object') WHERE paper_id IS NOT NULL);
  INSERT OR IGNORE INTO retention_refs(paper_id,source,source_key)
    SELECT paper_id,'digests',json_array(NEW.day,NEW.lang,NEW.kind) FROM (SELECT value AS paper_id FROM json_each(NEW.picks) WHERE type='text' UNION SELECT value->>'paperId' FROM json_each(NEW.radar) WHERE type='object') WHERE paper_id IS NOT NULL;
END;
CREATE TRIGGER retention_digests_delete AFTER DELETE ON digests BEGIN
  DELETE FROM retention_refs WHERE source='digests' AND source_key=json_array(OLD.day,OLD.lang,OLD.kind);
END;

INSERT OR IGNORE INTO retention_refs(paper_id,source,source_key)
  SELECT paper_id,'suggestions',source_key FROM (SELECT j.value AS paper_id,t.id AS source_key FROM suggestions t,json_each(t.paper_ids) j WHERE j.type='text');
CREATE TRIGGER retention_suggestions_insert AFTER INSERT ON suggestions BEGIN
  INSERT OR IGNORE INTO retention_refs(paper_id,source,source_key)
    SELECT paper_id,'suggestions',NEW.id FROM (SELECT value AS paper_id FROM json_each(NEW.paper_ids) WHERE type='text') WHERE paper_id IS NOT NULL;
END;
CREATE TRIGGER retention_suggestions_update AFTER UPDATE OF paper_ids ON suggestions
WHEN OLD.paper_ids IS NOT NEW.paper_ids BEGIN
  DELETE FROM retention_refs WHERE source='suggestions' AND source_key=OLD.id
    AND paper_id NOT IN (SELECT paper_id FROM (SELECT value AS paper_id FROM json_each(NEW.paper_ids) WHERE type='text') WHERE paper_id IS NOT NULL);
  INSERT OR IGNORE INTO retention_refs(paper_id,source,source_key)
    SELECT paper_id,'suggestions',NEW.id FROM (SELECT value AS paper_id FROM json_each(NEW.paper_ids) WHERE type='text') WHERE paper_id IS NOT NULL;
END;
CREATE TRIGGER retention_suggestions_delete AFTER DELETE ON suggestions BEGIN
  DELETE FROM retention_refs WHERE source='suggestions' AND source_key=OLD.id;
END;

INSERT OR IGNORE INTO retention_refs(paper_id,source,source_key)
  SELECT paper_id,'idea_index',source_key FROM (SELECT j.value AS paper_id,t.id AS source_key FROM idea_index t,json_each(t.paper_ids) j WHERE j.type='text');
CREATE TRIGGER retention_idea_index_insert AFTER INSERT ON idea_index BEGIN
  INSERT OR IGNORE INTO retention_refs(paper_id,source,source_key)
    SELECT paper_id,'idea_index',NEW.id FROM (SELECT value AS paper_id FROM json_each(NEW.paper_ids) WHERE type='text') WHERE paper_id IS NOT NULL;
END;
CREATE TRIGGER retention_idea_index_update AFTER UPDATE OF paper_ids ON idea_index
WHEN OLD.paper_ids IS NOT NEW.paper_ids BEGIN
  DELETE FROM retention_refs WHERE source='idea_index' AND source_key=OLD.id
    AND paper_id NOT IN (SELECT paper_id FROM (SELECT value AS paper_id FROM json_each(NEW.paper_ids) WHERE type='text') WHERE paper_id IS NOT NULL);
  INSERT OR IGNORE INTO retention_refs(paper_id,source,source_key)
    SELECT paper_id,'idea_index',NEW.id FROM (SELECT value AS paper_id FROM json_each(NEW.paper_ids) WHERE type='text') WHERE paper_id IS NOT NULL;
END;
CREATE TRIGGER retention_idea_index_delete AFTER DELETE ON idea_index BEGIN
  DELETE FROM retention_refs WHERE source='idea_index' AND source_key=OLD.id;
END;

INSERT OR IGNORE INTO retention_refs(paper_id,source,source_key)
  SELECT paper_id,'working_paper_index',source_key FROM (SELECT j.value AS paper_id,t.id AS source_key FROM working_paper_index t,json_each(t.paper_ids) j WHERE j.type='text');
CREATE TRIGGER retention_working_paper_index_insert AFTER INSERT ON working_paper_index BEGIN
  INSERT OR IGNORE INTO retention_refs(paper_id,source,source_key)
    SELECT paper_id,'working_paper_index',NEW.id FROM (SELECT value AS paper_id FROM json_each(NEW.paper_ids) WHERE type='text') WHERE paper_id IS NOT NULL;
END;
CREATE TRIGGER retention_working_paper_index_update AFTER UPDATE OF paper_ids ON working_paper_index
WHEN OLD.paper_ids IS NOT NEW.paper_ids BEGIN
  DELETE FROM retention_refs WHERE source='working_paper_index' AND source_key=OLD.id
    AND paper_id NOT IN (SELECT paper_id FROM (SELECT value AS paper_id FROM json_each(NEW.paper_ids) WHERE type='text') WHERE paper_id IS NOT NULL);
  INSERT OR IGNORE INTO retention_refs(paper_id,source,source_key)
    SELECT paper_id,'working_paper_index',NEW.id FROM (SELECT value AS paper_id FROM json_each(NEW.paper_ids) WHERE type='text') WHERE paper_id IS NOT NULL;
END;
CREATE TRIGGER retention_working_paper_index_delete AFTER DELETE ON working_paper_index BEGIN
  DELETE FROM retention_refs WHERE source='working_paper_index' AND source_key=OLD.id;
END;

UPDATE litscout_schema SET version=22;
