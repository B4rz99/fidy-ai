-- Email approval is bound to one still-pending pairing and one verified credential revision.
-- Only a digest of the delivered proof is retained; the outbox carries no mailbox or proof.
CREATE TABLE browser_pairing_email_proofs (
  pairing_id TEXT PRIMARY KEY NOT NULL REFERENCES browser_login_pairings(id) ON DELETE CASCADE,
  work_id TEXT NOT NULL UNIQUE CHECK (length(work_id) = 36),
  user_id TEXT NOT NULL REFERENCES users(id),
  email_address TEXT NOT NULL,
  credential_verified_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('awaiting_delivery', 'sending', 'awaiting_proof', 'rejected', 'ambiguous', 'approved')),
  public_code TEXT UNIQUE CHECK (public_code IS NULL OR length(public_code) = 9),
  proof_digest BLOB CHECK (proof_digest IS NULL OR length(proof_digest) = 32),
  proof_expires_at_ms INTEGER,
  expires_at_ms INTEGER NOT NULL,
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 5),
  wrong_attempts INTEGER NOT NULL DEFAULT 0 CHECK (wrong_attempts BETWEEN 0 AND 5),
  last_requested_at_ms INTEGER NOT NULL,
  CHECK ((state IN ('sending', 'awaiting_proof') AND public_code IS NOT NULL AND proof_digest IS NOT NULL AND proof_expires_at_ms IS NOT NULL) OR
    (state NOT IN ('sending', 'awaiting_proof') AND public_code IS NULL AND proof_digest IS NULL AND proof_expires_at_ms IS NULL))
) STRICT;
CREATE TABLE browser_pairing_email_outbox (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  created_at_ms INTEGER NOT NULL,
  last_attempt_at_ms INTEGER,
  published_at_ms INTEGER
) STRICT;
