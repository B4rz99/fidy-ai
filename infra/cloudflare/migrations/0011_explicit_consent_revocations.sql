-- A User's explicit withdrawal of onboarding Consent is append-only and immediately blocks PAT work.
CREATE TABLE consent_user_revocations (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
  grant_record_id TEXT NOT NULL REFERENCES onboarding_consent_records(id),
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  occurred_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER consent_user_revocation_requires_grant BEFORE INSERT ON consent_user_revocations
WHEN NOT EXISTS (
  SELECT 1 FROM onboarding_consent_records AS g
  JOIN web_sessions AS w ON w.user_id = g.user_id
  WHERE g.id = NEW.grant_record_id AND g.user_id = NEW.user_id
    AND w.id = NEW.session_id AND w.revoked_at_ms IS NULL
    AND w.idle_expires_at_ms > NEW.occurred_at_ms AND w.hard_expires_at_ms > NEW.occurred_at_ms
)
BEGIN SELECT RAISE(ABORT, 'consent_revocation_requires_user_session'); END;
CREATE TRIGGER consent_user_revocations_no_update BEFORE UPDATE ON consent_user_revocations
BEGIN SELECT RAISE(ABORT, 'consent_append_only'); END;
CREATE TRIGGER consent_user_revocations_no_delete BEFORE DELETE ON consent_user_revocations
BEGIN SELECT RAISE(ABORT, 'consent_append_only'); END;
