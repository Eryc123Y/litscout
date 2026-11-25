CREATE TABLE daily_runs (
  id TEXT PRIMARY KEY NOT NULL,
  run_day TEXT NOT NULL,
  started_at TEXT NOT NULL,
  target_day TEXT NOT NULL,
  finished_at TEXT,
  steps TEXT,
  rows_written INTEGER
);
CREATE INDEX daily_runs_recent ON daily_runs(started_at DESC, id DESC);
CREATE INDEX daily_runs_reported ON daily_runs(run_day) WHERE finished_at IS NOT NULL;
UPDATE litscout_schema SET version=14;
