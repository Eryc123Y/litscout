-- Project, idea and draft bodies the owner chose to upload (vault.uploadBodies),
-- shown read-only on the web. NULL when not uploaded. Obsidian stays the editor.
ALTER TABLE vault_notes ADD COLUMN body_md TEXT;

DROP VIEW vault_staged_notes;
CREATE VIEW vault_staged_notes AS
SELECT part, snapshot, value ->> 'id' AS id, value ->> 'path' AS path,
       value ->> 'kind' AS kind, value ->> 'title' AS title, value -> 'frontmatter' AS frontmatter,
       value ->> 'hash' AS hash, value ->> 'bodyHash' AS body_hash, value ->> 'fingerprint' AS fingerprint,
       value ->> 'titleNorm' AS title_norm, value ->> 'body' AS body_md
FROM vault_index_parts, json_each(notes);

UPDATE litscout_schema SET version=24;
