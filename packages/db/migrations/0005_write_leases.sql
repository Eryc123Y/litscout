CREATE TABLE write_leases (
  id TEXT PRIMARY KEY NOT NULL,
  day TEXT NOT NULL,
  reserved INTEGER NOT NULL,
  estimate INTEGER NOT NULL,
  created_at TEXT NOT NULL
) WITHOUT ROWID;
UPDATE litscout_schema SET version=4;
