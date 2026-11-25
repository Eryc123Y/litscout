-- History ratings exclude the much larger stream of opens and saves.
CREATE INDEX events_ratings_by_day ON events(user_id,day,at,id,paper_id,kind,source)
  WHERE kind IN ('rate_up','rate_down','rate_clear');

-- Reserve pruning work, including uncertain batches, on the same ledger row.
ALTER TABLE daily_write_usage ADD COLUMN prune_charged INTEGER NOT NULL DEFAULT 0;

ALTER TABLE alphaxiv_items ADD COLUMN library_added_at TEXT
  GENERATED ALWAYS AS (coalesce(saved_at,synced_at)) VIRTUAL;
ALTER TABLE alphaxiv_items ADD COLUMN library_key TEXT
  GENERATED ALWAYS AS (CASE paper_type WHEN 'public' THEN paper_id ELSE 'private:'||alphaxiv_id END) VIRTUAL;
CREATE INDEX alphaxiv_library_order ON alphaxiv_items(user_id,library_added_at,library_key)
  WHERE removed_at IS NULL AND deleted_at IS NULL;

-- The Library needs the folder names, independent of its results page.
-- Count active public memberships by name, so an item edit or removal can
-- remove the last occurrence of a name without scanning the mirror.
CREATE TABLE alphaxiv_folder_counts (
  user_id TEXT NOT NULL,
  folder_id TEXT NOT NULL,
  path TEXT NOT NULL,
  n INTEGER NOT NULL,
  PRIMARY KEY(user_id,folder_id,path)
) WITHOUT ROWID;
INSERT INTO alphaxiv_folder_counts(user_id,folder_id,path,n)
  SELECT user_id,folder_id,path,count(*) FROM (
    SELECT DISTINCT a.user_id,a.alphaxiv_id,f.value->>'id' AS folder_id,f.value->>'path' AS path
    FROM alphaxiv_items a,json_each(a.folders) f
    WHERE a.paper_type='public' AND a.removed_at IS NULL AND a.deleted_at IS NULL
      AND f.value->>'id' IS NOT NULL AND f.value->>'path' IS NOT NULL
  ) GROUP BY user_id,folder_id,path;
CREATE TRIGGER alphaxiv_folders_insert AFTER INSERT ON alphaxiv_items
WHEN NEW.paper_type='public' AND NEW.removed_at IS NULL AND NEW.deleted_at IS NULL BEGIN
  INSERT INTO alphaxiv_folder_counts(user_id,folder_id,path,n)
    SELECT DISTINCT NEW.user_id,value->>'id',value->>'path',1 FROM json_each(NEW.folders)
    WHERE value->>'id' IS NOT NULL AND value->>'path' IS NOT NULL
    ON CONFLICT(user_id,folder_id,path) DO UPDATE SET n=n+1;
END;
CREATE TRIGGER alphaxiv_folders_delete AFTER DELETE ON alphaxiv_items
WHEN OLD.paper_type='public' AND OLD.removed_at IS NULL AND OLD.deleted_at IS NULL BEGIN
  UPDATE alphaxiv_folder_counts SET n=n-1 WHERE user_id=OLD.user_id AND (folder_id,path) IN (
    SELECT value->>'id',value->>'path' FROM json_each(OLD.folders));
  DELETE FROM alphaxiv_folder_counts WHERE user_id=OLD.user_id AND n=0 AND (folder_id,path) IN (
    SELECT value->>'id',value->>'path' FROM json_each(OLD.folders));
END;
CREATE TRIGGER alphaxiv_folders_update AFTER UPDATE OF user_id,paper_type,folders,removed_at,deleted_at ON alphaxiv_items
WHEN OLD.user_id IS NOT NEW.user_id OR OLD.paper_type IS NOT NEW.paper_type OR OLD.folders IS NOT NEW.folders
  OR (OLD.removed_at IS NULL) IS NOT (NEW.removed_at IS NULL) OR (OLD.deleted_at IS NULL) IS NOT (NEW.deleted_at IS NULL) BEGIN
  UPDATE alphaxiv_folder_counts SET n=n-1 WHERE OLD.paper_type='public' AND OLD.removed_at IS NULL AND OLD.deleted_at IS NULL
    AND user_id=OLD.user_id AND (folder_id,path) IN (SELECT value->>'id',value->>'path' FROM json_each(OLD.folders));
  DELETE FROM alphaxiv_folder_counts WHERE OLD.paper_type='public' AND OLD.removed_at IS NULL AND OLD.deleted_at IS NULL
    AND user_id=OLD.user_id AND n=0 AND (folder_id,path) IN (SELECT value->>'id',value->>'path' FROM json_each(OLD.folders));
  INSERT INTO alphaxiv_folder_counts(user_id,folder_id,path,n)
    SELECT DISTINCT NEW.user_id,value->>'id',value->>'path',1 FROM json_each(NEW.folders)
    WHERE NEW.paper_type='public' AND NEW.removed_at IS NULL AND NEW.deleted_at IS NULL
      AND value->>'id' IS NOT NULL AND value->>'path' IS NOT NULL
    ON CONFLICT(user_id,folder_id,path) DO UPDATE SET n=n+1;
END;

-- The conflict policy of the outer upsert overrides INSERT OR IGNORE in triggers.
-- An explicit upsert clause keeps overlapping paper references on edits.
DROP TRIGGER retention_digests_update;
CREATE TRIGGER retention_digests_update AFTER UPDATE OF picks,radar ON digests
WHEN OLD.picks IS NOT NEW.picks OR OLD.radar IS NOT NEW.radar BEGIN
  DELETE FROM retention_refs WHERE source='digests' AND source_key=json_array(OLD.day,OLD.lang,OLD.kind)
    AND paper_id NOT IN (SELECT paper_id FROM (SELECT value AS paper_id FROM json_each(NEW.picks) WHERE type='text' UNION SELECT value->>'paperId' FROM json_each(NEW.radar) WHERE type='object') WHERE paper_id IS NOT NULL);
  INSERT INTO retention_refs(paper_id,source,source_key)
    SELECT paper_id,'digests',json_array(NEW.day,NEW.lang,NEW.kind) FROM (SELECT value AS paper_id FROM json_each(NEW.picks) WHERE type='text' UNION SELECT value->>'paperId' FROM json_each(NEW.radar) WHERE type='object') WHERE paper_id IS NOT NULL
    ON CONFLICT(paper_id,source,source_key) DO NOTHING;
END;

DROP TRIGGER retention_suggestions_update;
CREATE TRIGGER retention_suggestions_update AFTER UPDATE OF paper_ids ON suggestions
WHEN OLD.paper_ids IS NOT NEW.paper_ids BEGIN
  DELETE FROM retention_refs WHERE source='suggestions' AND source_key=OLD.id
    AND paper_id NOT IN (SELECT paper_id FROM (SELECT value AS paper_id FROM json_each(NEW.paper_ids) WHERE type='text') WHERE paper_id IS NOT NULL);
  INSERT INTO retention_refs(paper_id,source,source_key)
    SELECT paper_id,'suggestions',NEW.id FROM (SELECT value AS paper_id FROM json_each(NEW.paper_ids) WHERE type='text') WHERE paper_id IS NOT NULL
    ON CONFLICT(paper_id,source,source_key) DO NOTHING;
END;

DROP TRIGGER retention_idea_index_update;
CREATE TRIGGER retention_idea_index_update AFTER UPDATE OF paper_ids ON idea_index
WHEN OLD.paper_ids IS NOT NEW.paper_ids BEGIN
  DELETE FROM retention_refs WHERE source='idea_index' AND source_key=OLD.id
    AND paper_id NOT IN (SELECT paper_id FROM (SELECT value AS paper_id FROM json_each(NEW.paper_ids) WHERE type='text') WHERE paper_id IS NOT NULL);
  INSERT INTO retention_refs(paper_id,source,source_key)
    SELECT paper_id,'idea_index',NEW.id FROM (SELECT value AS paper_id FROM json_each(NEW.paper_ids) WHERE type='text') WHERE paper_id IS NOT NULL
    ON CONFLICT(paper_id,source,source_key) DO NOTHING;
END;

DROP TRIGGER retention_working_paper_index_update;
CREATE TRIGGER retention_working_paper_index_update AFTER UPDATE OF paper_ids ON working_paper_index
WHEN OLD.paper_ids IS NOT NEW.paper_ids BEGIN
  DELETE FROM retention_refs WHERE source='working_paper_index' AND source_key=OLD.id
    AND paper_id NOT IN (SELECT paper_id FROM (SELECT value AS paper_id FROM json_each(NEW.paper_ids) WHERE type='text') WHERE paper_id IS NOT NULL);
  INSERT INTO retention_refs(paper_id,source,source_key)
    SELECT paper_id,'working_paper_index',NEW.id FROM (SELECT value AS paper_id FROM json_each(NEW.paper_ids) WHERE type='text') WHERE paper_id IS NOT NULL
    ON CONFLICT(paper_id,source,source_key) DO NOTHING;
END;

UPDATE litscout_schema SET version=23;
