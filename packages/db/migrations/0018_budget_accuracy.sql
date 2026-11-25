ALTER TABLE daily_write_usage ADD COLUMN unaccounted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE daily_write_usage ADD COLUMN estimate_overrun INTEGER NOT NULL DEFAULT 0;
ALTER TABLE write_leases ADD COLUMN expired INTEGER NOT NULL DEFAULT 0;
UPDATE litscout_schema SET version=17;
