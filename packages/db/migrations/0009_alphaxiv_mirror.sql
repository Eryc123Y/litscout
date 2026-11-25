CREATE TABLE alphaxiv_mirror (
  user_id TEXT NOT NULL DEFAULT 'u_owner',
  alphaxiv_id TEXT NOT NULL,
  paper_type TEXT NOT NULL DEFAULT 'public' CHECK (paper_type IN ('public', 'private')),
  paper_id TEXT REFERENCES papers(id) ON DELETE CASCADE ON UPDATE CASCADE,
  title TEXT NOT NULL,
  folders TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'saved' CHECK (status IN ('saved', 'reading', 'read')),
  publication_date TEXT,
  annotation TEXT,
  saved_at TEXT,
  synced_at TEXT NOT NULL,
  removed_at TEXT,
  deleted_at TEXT,
  rev INTEGER NOT NULL DEFAULT 1,
  CHECK ((paper_type = 'public' AND paper_id IS NOT NULL) OR
    (paper_type = 'private' AND paper_id IS NULL AND publication_date IS NULL AND annotation IS NULL)),
  PRIMARY KEY (user_id, paper_type, alphaxiv_id)
);

INSERT INTO alphaxiv_mirror (
  user_id, alphaxiv_id, paper_id, title, folders, publication_date, saved_at, synced_at, removed_at, deleted_at, rev
)
SELECT a.user_id, lower(a.alphaxiv_id), a.paper_id, p.title,
  (SELECT json_group_array(json_object('id', lower(f.value), 'path', f.value, 'type', 'custom'))
   FROM json_each(a.folders) f
   WHERE f.type = 'text' AND f.value GLOB '????????-????-????-????-????????????'
     AND length(replace(f.value,'-','')) = 32
     AND lower(replace(f.value,'-','')) NOT GLOB '*[^0-9a-f]*'
     AND ((substr(f.value,15,1) BETWEEN '1' AND '8' AND lower(substr(f.value,20,1)) IN ('8','9','a','b'))
       OR lower(f.value) IN ('00000000-0000-0000-0000-000000000000','ffffffff-ffff-ffff-ffff-ffffffffffff'))),
  p.published_on, a.saved_at, a.synced_at, a.removed_at, a.deleted_at, a.rev
FROM alphaxiv_items a JOIN papers p ON p.id = a.paper_id
WHERE true
ON CONFLICT (user_id, paper_type, alphaxiv_id) DO NOTHING;

DROP TABLE alphaxiv_items;
ALTER TABLE alphaxiv_mirror RENAME TO alphaxiv_items;
CREATE INDEX alphaxiv_items_lookup_0 ON alphaxiv_items (alphaxiv_id);
CREATE INDEX alphaxiv_items_lookup_1 ON alphaxiv_items (paper_id);
CREATE INDEX alphaxiv_items_active ON alphaxiv_items (user_id, paper_type, paper_id)
  WHERE removed_at IS NULL AND deleted_at IS NULL;

UPDATE litscout_schema SET version=8;
