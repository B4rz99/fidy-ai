-- First-party revocation is distinct from refresh replay and preserves its fresh browser origin.
CREATE TABLE oauth_user_revocation_consents (
  connection_id TEXT PRIMARY KEY NOT NULL REFERENCES oauth_connections(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  reason TEXT NOT NULL CHECK (reason IN ('user_one','user_all')),
  disclosure_revision TEXT NOT NULL,
  disclosure_text TEXT NOT NULL,
  occurred_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER oauth_user_revocation_no_update BEFORE UPDATE ON oauth_user_revocation_consents
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
CREATE TRIGGER oauth_user_revocation_no_delete BEFORE DELETE ON oauth_user_revocation_consents
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
CREATE INDEX oauth_activity_connection ON pat_audit(user_id,oauth_connection_id,occurred_at_ms DESC,id DESC);
