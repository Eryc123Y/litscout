ALTER TABLE write_leases ADD COLUMN expiry_day TEXT;
UPDATE litscout_schema SET version=18;
