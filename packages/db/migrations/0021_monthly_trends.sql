CREATE TABLE monthly_trends (
  topic TEXT NOT NULL,
  month TEXT NOT NULL,
  volume INTEGER NOT NULL,
  shortlisted INTEGER NOT NULL,
  pick_count INTEGER NOT NULL,
  radar_hits INTEGER NOT NULL,
  radar TEXT NOT NULL,
  save_count INTEGER NOT NULL,
  rating_count INTEGER NOT NULL,
  activity_count INTEGER NOT NULL,
  recurring TEXT NOT NULL,
  rising TEXT NOT NULL,
  picks TEXT NOT NULL,
  activity TEXT NOT NULL,
  PRIMARY KEY (topic, month)
) WITHOUT ROWID;
UPDATE litscout_schema SET version=20;
