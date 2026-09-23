-- Ten-minute source admission retains only a keyed digest of the edge-observed visitor IP.
CREATE TABLE pat_pairing_admission (
  source_digest BLOB PRIMARY KEY NOT NULL CHECK (length(source_digest) = 32),
  window_start_ms INTEGER NOT NULL,
  started_count INTEGER NOT NULL CHECK (started_count BETWEEN 1 AND 20)
) STRICT;
CREATE INDEX pat_pairing_admission_expiry ON pat_pairing_admission(window_start_ms);
-- A short-lived private proof joins a public request only after a fresh WebSession reviews it.
CREATE TABLE pat_pairings (
  id TEXT PRIMARY KEY NOT NULL,
  public_code TEXT NOT NULL UNIQUE,
  proof_digest BLOB NOT NULL CHECK (length(proof_digest) = 32),
  recipient_label TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  lifetime_days INTEGER NOT NULL CHECK (lifetime_days IN (7,30,90,365)),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms = created_at_ms + 600000),
  state TEXT NOT NULL DEFAULT 'pending_approval' CHECK (state IN ('pending_approval','approved_awaiting_claim','claimed','expired_unapproved','revoked_unclaimed')),
  user_id TEXT REFERENCES users(id),
  approved_at_ms INTEGER,
  wrong_attempts INTEGER NOT NULL DEFAULT 0 CHECK (wrong_attempts BETWEEN 0 AND 32767),
  last_poll_at_ms INTEGER,
  minimum_poll_seconds INTEGER NOT NULL DEFAULT 5 CHECK (minimum_poll_seconds BETWEEN 5 AND 60),
  CHECK ((state = 'pending_approval' AND user_id IS NULL AND approved_at_ms IS NULL) OR state <> 'pending_approval'),
  CHECK ((state IN ('approved_awaiting_claim','claimed') AND user_id IS NOT NULL AND approved_at_ms IS NOT NULL) OR state NOT IN ('approved_awaiting_claim','claimed'))
) STRICT;
CREATE INDEX pat_pairings_capacity ON pat_pairings(created_at_ms);
CREATE TABLE pats (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  short_id TEXT NOT NULL UNIQUE CHECK (length(short_id) = 8),
  bearer_digest BLOB NOT NULL CHECK (length(bearer_digest) = 32),
  recipient_label TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  lifetime_days INTEGER NOT NULL CHECK (lifetime_days IN (7,30,90,365)),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > created_at_ms),
  last_used_at_ms INTEGER,
  revoked_at_ms INTEGER,
  pairing_id TEXT UNIQUE REFERENCES pat_pairings(id),
  request_id TEXT UNIQUE,
  CHECK ((pairing_id IS NULL) <> (request_id IS NULL)),
  CHECK (expires_at_ms <= created_at_ms + lifetime_days * 86400000)
) STRICT;
CREATE TRIGGER paired_pat_requires_claim BEFORE INSERT ON pats
WHEN NEW.pairing_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM pat_pairings WHERE id = NEW.pairing_id AND user_id = NEW.user_id
    AND state = 'claimed' AND expires_at_ms > NEW.created_at_ms
)
BEGIN SELECT RAISE(ABORT,'pat_pairing_not_claimable'); END;
CREATE INDEX pats_user_active ON pats(user_id,revoked_at_ms,expires_at_ms);
CREATE TABLE pat_grant_consents (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  pairing_id TEXT UNIQUE REFERENCES pat_pairings(id),
  request_id TEXT UNIQUE,
  disclosure_revision TEXT NOT NULL,
  disclosure_text TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL,
  CHECK ((pairing_id IS NULL) <> (request_id IS NULL))
) STRICT;
CREATE TRIGGER pat_grant_consents_no_update BEFORE UPDATE ON pat_grant_consents
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
CREATE TRIGGER pat_grant_consents_no_delete BEFORE DELETE ON pat_grant_consents
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
CREATE TABLE pat_audit (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT REFERENCES web_sessions(id),
  pat_id TEXT REFERENCES pats(id),
  operation TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted','rejected')),
  occurred_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER pat_audit_no_update BEFORE UPDATE ON pat_audit
BEGIN SELECT RAISE(ABORT,'audit_append_only'); END;
CREATE TABLE pat_review_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  occurred_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX pat_review_rate ON pat_review_attempts(session_id,occurred_at_ms);
