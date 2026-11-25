-- Only imported papers with omitted standard links use this recipe list.
ALTER TABLE papers ADD COLUMN derived_arxiv_links TEXT NOT NULL DEFAULT '[]';
UPDATE litscout_schema SET version=21;
