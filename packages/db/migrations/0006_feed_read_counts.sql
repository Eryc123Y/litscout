-- Unreleased migration 0006: indexed keyset reads and incremental counters.
ALTER TABLE feed_items ADD COLUMN rank_sort INTEGER GENERATED ALWAYS AS (coalesce(rank_in_source,-1)) VIRTUAL;
CREATE INDEX feed_items_read_order ON feed_items(day,rank_sort,paper_id,source);
CREATE INDEX paper_ids_value ON paper_ids(value,scheme,paper_id);
CREATE TABLE feed_read_counts (
  day TEXT NOT NULL REFERENCES feed_days(day) ON DELETE CASCADE ON UPDATE CASCADE,
  kind TEXT NOT NULL,
  key TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY(day,kind,key)
) WITHOUT ROWID;

-- One backfill for pre-existing rows. Runtime triggers only touch changed memberships.
  INSERT INTO feed_read_counts(day,kind,key,n)
  SELECT day,kind,key,1*sum(n) FROM (WITH live AS MATERIALIZED (SELECT f.day,f.source,f.topics,f.shortlisted,p.venue,
 (p.abstract IS NULL OR trim(p.abstract,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))='') AS no_abstract,
 EXISTS(SELECT 1 FROM summaries WHERE paper_id=p.id) AS summarised
 FROM feed_items f JOIN papers p ON p.id=f.paper_id WHERE p.deleted_at IS NULL)
    SELECT day,json_extract(j.value,'$[0]') AS kind,json_extract(j.value,'$[1]') AS key,json_extract(j.value,'$[2]') AS n
    FROM live,json_each(json_array(
      json_array('total','',1),json_array('sources',source,1),
      json_array('venueCounts',coalesce(venue,''),venue IS NOT NULL),
      json_array('shortlisted','',shortlisted),json_array('summarised','',summarised),json_array('noAbstract','',no_abstract))) j
    UNION ALL SELECT day,'topics',j.value,1 FROM live,json_each(live.topics) j) WHERE n<>0 GROUP BY day,kind,key
  ON CONFLICT(day,kind,key) DO UPDATE SET n=n+excluded.n;

CREATE TRIGGER feed_counts_insert AFTER INSERT ON feed_items BEGIN
  INSERT INTO feed_read_counts(day,kind,key,n)
  SELECT day,kind,key,1*sum(n) FROM (WITH live AS MATERIALIZED (SELECT NEW.day AS day,NEW.source AS source,NEW.topics AS topics,NEW.shortlisted AS shortlisted,p.venue,
      (p.abstract IS NULL OR trim(p.abstract,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))='') AS no_abstract,
      EXISTS(SELECT 1 FROM summaries WHERE paper_id=p.id) AS summarised
      FROM papers p WHERE p.id=NEW.paper_id AND p.deleted_at IS NULL)
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
  SELECT day,kind,key,-1*sum(n) FROM (WITH live AS MATERIALIZED (SELECT OLD.day AS day,OLD.source AS source,OLD.topics AS topics,OLD.shortlisted AS shortlisted,p.venue,
      (p.abstract IS NULL OR trim(p.abstract,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))='') AS no_abstract,
      EXISTS(SELECT 1 FROM summaries WHERE paper_id=p.id) AS summarised
      FROM papers p WHERE p.id=OLD.paper_id AND p.deleted_at IS NULL AND EXISTS(SELECT 1 FROM feed_days WHERE day=OLD.day))
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
 AND EXISTS(SELECT 1 FROM papers WHERE id=OLD.paper_id) BEGIN
  INSERT INTO feed_read_counts(day,kind,key,n)
  SELECT day,kind,key,-1*sum(n) FROM (WITH live AS MATERIALIZED (SELECT OLD.day AS day,OLD.source AS source,OLD.topics AS topics,OLD.shortlisted AS shortlisted,p.venue,
      (p.abstract IS NULL OR trim(p.abstract,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))='') AS no_abstract,
      EXISTS(SELECT 1 FROM summaries WHERE paper_id=p.id) AS summarised
      FROM papers p WHERE p.id=OLD.paper_id AND p.deleted_at IS NULL AND EXISTS(SELECT 1 FROM feed_days WHERE day=OLD.day))
    SELECT day,json_extract(j.value,'$[0]') AS kind,json_extract(j.value,'$[1]') AS key,json_extract(j.value,'$[2]') AS n
    FROM live,json_each(json_array(
      json_array('total','',1),json_array('sources',source,1),
      json_array('venueCounts',coalesce(venue,''),venue IS NOT NULL),
      json_array('shortlisted','',shortlisted),json_array('summarised','',summarised),json_array('noAbstract','',no_abstract))) j
    UNION ALL SELECT day,'topics',j.value,1 FROM live,json_each(live.topics) j) WHERE n<>0 GROUP BY day,kind,key
  ON CONFLICT(day,kind,key) DO UPDATE SET n=n+excluded.n;
  INSERT INTO feed_read_counts(day,kind,key,n)
  SELECT day,kind,key,1*sum(n) FROM (WITH live AS MATERIALIZED (SELECT NEW.day AS day,NEW.source AS source,NEW.topics AS topics,NEW.shortlisted AS shortlisted,p.venue,
      (p.abstract IS NULL OR trim(p.abstract,char(9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279))='') AS no_abstract,
      EXISTS(SELECT 1 FROM summaries WHERE paper_id=p.id) AS summarised
      FROM papers p WHERE p.id=NEW.paper_id AND p.deleted_at IS NULL)
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

CREATE TRIGGER feed_counts_paper_delete BEFORE DELETE ON papers BEGIN
  DELETE FROM feed_items WHERE paper_id=OLD.id;
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
UPDATE litscout_schema SET version=5;
