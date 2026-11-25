-- The original schema reserved the library tables and link metadata.
ALTER TABLE paper_links ADD COLUMN user_id TEXT NOT NULL DEFAULT 'u_owner';

ALTER TABLE notes ADD COLUMN client TEXT;

CREATE INDEX library_items_active ON library_items(user_id, added_at DESC, paper_id DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX paper_links_check_queue ON paper_links(user_id, checked_at, id);

CREATE TRIGGER quick_note_insert BEFORE INSERT ON notes
WHEN NEW.target_type <> 'paper' OR length(NEW.body_md) > 4000
BEGIN
  SELECT RAISE(ABORT, 'Invalid quick note');
END;
CREATE TRIGGER quick_note_update BEFORE UPDATE OF target_type, body_md ON notes
WHEN NEW.target_type <> 'paper' OR length(NEW.body_md) > 4000
BEGIN
  SELECT RAISE(ABORT, 'Invalid quick note');
END;

UPDATE litscout_schema SET version=6;
