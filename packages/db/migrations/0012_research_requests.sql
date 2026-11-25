ALTER TABLE suggestions ADD COLUMN request_id TEXT REFERENCES vault_requests(id);
CREATE INDEX suggestions_by_owner_id ON suggestions(user_id, id) WHERE deleted_at IS NULL;
CREATE INDEX suggestions_by_request ON suggestions(request_id) WHERE request_id IS NOT NULL;
CREATE INDEX vault_requests_target ON vault_requests(target_note_id, kind, created_at DESC, id DESC);
CREATE INDEX vault_requests_pending_paper ON vault_requests(json_extract(payload,'$.paperId'), kind) WHERE state='queued';
UPDATE litscout_schema SET version=11;
