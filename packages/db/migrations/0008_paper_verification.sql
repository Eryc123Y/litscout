ALTER TABLE papers ADD COLUMN verified INTEGER NOT NULL DEFAULT 1 CHECK (verified IN (0, 1));

-- Existing publisher records came from citation metadata fallback.
UPDATE papers SET verified=0 WHERE source='publisher';

UPDATE litscout_schema SET version=7;
