-- Compact rows expire 12 months after their last listing (ADR 0004,
-- decision 6). The first listing is never later, so this index finds the
-- candidates. Only compact rows are in it: ingest writes are unchanged.
CREATE INDEX paper_index_compact_day ON paper_index(day,paper_id) WHERE has_canonical=0;

UPDATE litscout_schema SET version=25;
