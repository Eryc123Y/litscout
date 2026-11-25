CREATE INDEX paper_ids_backup_key ON paper_ids(paper_id,scheme,value);
DROP INDEX paper_ids_lookup_0;
UPDATE litscout_schema SET version=15;
