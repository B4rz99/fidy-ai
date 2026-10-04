CREATE TABLE media_submissions (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), portfolio_id TEXT NOT NULL,
 bsuid TEXT NOT NULL, message_id TEXT NOT NULL, input_digest TEXT NOT NULL, media_id TEXT, caption TEXT,
 accepted_at_ms INTEGER NOT NULL, expires_at_ms INTEGER NOT NULL,
 service_market TEXT NOT NULL, locale TEXT NOT NULL, time_zone TEXT NOT NULL,
 UNIQUE(user_id,portfolio_id,message_id), CHECK(expires_at_ms = accepted_at_ms + 2592000000)
);
CREATE TABLE media_submission_audit (
 id TEXT PRIMARY KEY REFERENCES media_submissions(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id), outcome TEXT NOT NULL CHECK(outcome = 'accepted'),
 occurred_at_ms INTEGER NOT NULL
);
CREATE TABLE media_submission_outbox (
 submission_id TEXT PRIMARY KEY REFERENCES media_submissions(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id), created_at_ms INTEGER NOT NULL
);
CREATE TABLE media_needs_review (
 id TEXT PRIMARY KEY REFERENCES media_submissions(id) ON DELETE CASCADE,
 user_id TEXT NOT NULL REFERENCES users(id), reason TEXT NOT NULL CHECK(reason IN ('extraction-unavailable','unparseable-material')),
 created_at_ms INTEGER NOT NULL
);
CREATE TABLE media_publication_assertions (
 id TEXT PRIMARY KEY,
 published INTEGER NOT NULL CONSTRAINT media_publication_required CHECK(published = 1),
 capacity INTEGER NOT NULL CONSTRAINT media_work_capacity CHECK(capacity = 1)
);
CREATE INDEX media_expiry ON media_submissions(expires_at_ms,id);
CREATE INDEX media_outstanding_user ON media_submission_outbox(user_id,submission_id);
CREATE TRIGGER media_audit_append_only BEFORE UPDATE ON media_submission_audit
BEGIN SELECT RAISE(ABORT,'media_audit_append_only'); END;

