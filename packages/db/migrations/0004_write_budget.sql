CREATE TABLE daily_write_usage (
  day TEXT PRIMARY KEY NOT NULL,
  rows_written INTEGER NOT NULL DEFAULT 0,
  reserved INTEGER NOT NULL DEFAULT 0
) WITHOUT ROWID;
DELETE FROM sync_cursors WHERE name IN ('legacy:project-brief.md','legacy:feedback.md','legacy:ledger.json','legacy:ledger.md','legacy:assets/venues.json','legacy:assets/venue-days.json','legacy:venues.json');
UPDATE litscout_schema SET version=3;
