-- A browser-held verifier and an independently authenticated WhatsApp decision must meet before
-- a WebSession can exist. Public codes are locators, never credentials.
CREATE TABLE browser_login_pairings (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  public_code TEXT NOT NULL UNIQUE CHECK (length(public_code) = 9),
  verifier_digest BLOB NOT NULL CHECK (length(verifier_digest) = 32),
  user_id TEXT REFERENCES users(id),
  state TEXT NOT NULL DEFAULT 'pending_approval' CHECK (state IN ('pending_approval', 'ready', 'consumed', 'invalidated')),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms = created_at_ms + 600000),
  wrong_attempts INTEGER NOT NULL DEFAULT 0 CHECK (wrong_attempts BETWEEN 0 AND 5),
  last_poll_at_ms INTEGER,
  minimum_poll_interval_seconds INTEGER NOT NULL DEFAULT 5 CHECK (minimum_poll_interval_seconds BETWEEN 5 AND 60),
  CHECK ((state = 'pending_approval' AND user_id IS NULL) OR state <> 'pending_approval'),
  CHECK ((state = 'ready' OR state = 'consumed') = (user_id IS NOT NULL))
) STRICT;
CREATE TABLE browser_login_approvals (
  portfolio_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  pairing_id TEXT NOT NULL UNIQUE REFERENCES browser_login_pairings(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (portfolio_id, message_id)
) STRICT;
CREATE TRIGGER browser_login_approval_valid BEFORE INSERT ON browser_login_approvals
WHEN NOT EXISTS (
  SELECT 1 FROM browser_login_pairings AS p
  JOIN whatsapp_identities AS w ON w.user_id = NEW.user_id
  WHERE p.id = NEW.pairing_id AND p.state = 'pending_approval'
    AND w.portfolio_id = NEW.portfolio_id
)
BEGIN SELECT RAISE(ABORT, 'browser_login_approval_invalid'); END;
CREATE TRIGGER browser_login_approval_set_ready AFTER INSERT ON browser_login_approvals
BEGIN
  UPDATE browser_login_pairings SET state = 'ready', user_id = NEW.user_id
  WHERE id = NEW.pairing_id;
END;
CREATE TABLE web_sessions (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) = 36),
  pairing_id TEXT NOT NULL UNIQUE REFERENCES browser_login_pairings(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  token_digest BLOB NOT NULL UNIQUE CHECK (length(token_digest) = 32),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms = created_at_ms + 604800000),
  revoked_at_ms INTEGER
) STRICT;
CREATE TRIGGER web_session_requires_pairing BEFORE INSERT ON web_sessions
WHEN NOT EXISTS (
  SELECT 1 FROM browser_login_pairings AS p WHERE p.id = NEW.pairing_id
    AND p.state = 'consumed' AND p.user_id = NEW.user_id
    AND p.expires_at_ms > NEW.created_at_ms
)
BEGIN SELECT RAISE(ABORT, 'web_session_invalid_pairing'); END;
CREATE TABLE canonical_user_reads (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  occurred_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER canonical_user_reads_no_update BEFORE UPDATE ON canonical_user_reads
BEGIN SELECT RAISE(ABORT, 'audit_append_only'); END;
