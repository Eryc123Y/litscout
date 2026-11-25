ALTER TABLE api_tokens ADD COLUMN legacy_vault INTEGER NOT NULL DEFAULT 0 CHECK (legacy_vault IN (0, 1));
UPDATE api_tokens SET legacy_vault=1
WHERE EXISTS (
  SELECT 1 FROM json_each(CASE WHEN json_valid(api_tokens.scopes) THEN api_tokens.scopes END)
  WHERE value='ingest'
);
UPDATE litscout_schema SET version=19;
