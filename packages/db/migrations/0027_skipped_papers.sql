-- A paper the reader looked at and judged not worth keeping: the day's list
-- hides it. NULL when not skipped. Kept apart from the rating, which says
-- what the reader thinks of a paper they did read.
ALTER TABLE paper_state ADD COLUMN skipped_at TEXT;

UPDATE litscout_schema SET version=26;
