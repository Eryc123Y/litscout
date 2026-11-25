ALTER TABLE radar_grades ADD COLUMN action TEXT NOT NULL DEFAULT '';
ALTER TABLE radar_grades ADD COLUMN look_back INTEGER NOT NULL DEFAULT 0;
UPDATE litscout_schema SET version=2;
