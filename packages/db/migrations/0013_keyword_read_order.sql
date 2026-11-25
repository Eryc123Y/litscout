CREATE INDEX feed_items_keyword_read_order ON feed_items(day, shortlisted DESC, rank_sort, paper_id, source);
UPDATE litscout_schema SET version=12;
