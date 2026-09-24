-- One current candidate per User. A fresh browser session is required again at redemption.
-- Work identity, not the mailbox or code, is the only Queue/Workflow payload.
CREATE TABLE email_replacements (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  work_id TEXT NOT NULL UNIQUE CHECK (length(work_id) = 36),
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  candidate_email TEXT NOT NULL CHECK (candidate_email = lower(trim(candidate_email))),
  prior_email TEXT NOT NULL,
  prior_verified_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('awaiting_delivery', 'sending', 'awaiting_proof', 'rejected', 'ambiguous')),
  public_code TEXT UNIQUE CHECK (public_code IS NULL OR length(public_code) = 9),
  proof_digest BLOB CHECK (proof_digest IS NULL OR length(proof_digest) = 32),
  proof_expires_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms = created_at_ms + 600000),
  wrong_attempts INTEGER NOT NULL DEFAULT 0 CHECK (wrong_attempts BETWEEN 0 AND 5),
  CHECK ((state IN ('sending', 'awaiting_proof') AND public_code IS NOT NULL AND proof_digest IS NOT NULL AND proof_expires_at_ms IS NOT NULL)
    OR (state NOT IN ('sending', 'awaiting_proof') AND public_code IS NULL AND proof_digest IS NULL AND proof_expires_at_ms IS NULL))
) STRICT;
-- Admission survives rejected codes and candidate supersession for the User, not a proof generation.
CREATE TABLE email_replacement_limits (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id),
  window_started_at_ms INTEGER NOT NULL,
  requests INTEGER NOT NULL CHECK (requests BETWEEN 1 AND 5),
  last_work_id TEXT NOT NULL CHECK (length(last_work_id) = 36)
) STRICT;
CREATE TABLE email_replacement_outbox (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  created_at_ms INTEGER NOT NULL,
  last_attempt_at_ms INTEGER
) STRICT;
-- The same audit table records both account-security mutations without storing either mailbox.
CREATE TABLE email_replacement_audit (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  operation TEXT NOT NULL CHECK (operation IN ('requestEmailReplacement', 'completeEmailReplacement')),
  outcome TEXT NOT NULL CHECK (outcome IN ('accepted', 'rejected', 'replaced')),
  occurred_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER email_replacement_audit_no_update BEFORE UPDATE ON email_replacement_audit
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
