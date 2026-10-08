-- One browser-bound Google authorization per BrowserLoginPairing; no provider tokens retained.
CREATE TABLE provider_authentication_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  pairing_id TEXT NOT NULL UNIQUE REFERENCES browser_login_pairings(id) ON DELETE CASCADE,
  cookie_digest BLOB NOT NULL CHECK(length(cookie_digest) = 32),
  nonce TEXT NOT NULL,
  intent TEXT NOT NULL CHECK(intent IN ('signup','login')),
  disclosure_json TEXT,
  consent_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms <= created_at_ms + 600000),
  state TEXT NOT NULL CHECK(state IN ('pending','exchanging','verified','completed','rejected')),
  issuer TEXT,
  subject TEXT,
  contact_email TEXT,
  user_id TEXT REFERENCES users(id),
  CHECK((intent = 'signup') = (disclosure_json IS NOT NULL AND consent_at_ms IS NOT NULL))
) STRICT;
CREATE INDEX provider_attempt_expiry ON provider_authentication_attempts(expires_at_ms);
CREATE TABLE provider_credentials (
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  contact_email TEXT,
  established_at_ms INTEGER NOT NULL,
  PRIMARY KEY(issuer,subject)
) STRICT;
CREATE TABLE completed_provider_authentications (
  attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES provider_authentication_attempts(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id),
  completed_at_ms INTEGER NOT NULL,
  created_user INTEGER NOT NULL CHECK(created_user IN (0,1))
) STRICT;
CREATE TRIGGER provider_completion_requires_proof BEFORE INSERT ON completed_provider_authentications
WHEN NOT EXISTS (
 SELECT 1 FROM provider_authentication_attempts a
 JOIN provider_credentials c ON c.issuer = a.issuer AND c.subject = a.subject AND c.user_id = NEW.user_id
 JOIN browser_login_pairings p ON p.id = a.pairing_id AND p.state = 'ready' AND p.user_id = NEW.user_id
 WHERE a.id = NEW.attempt_id AND a.state = 'verified'
 AND a.expires_at_ms > NEW.completed_at_ms AND p.expires_at_ms > NEW.completed_at_ms AND p.wrong_attempts < 5
 AND (NEW.created_user = 0 OR (
   a.intent = 'signup' AND EXISTS(SELECT 1 FROM onboarding_consent_records g WHERE g.id = a.id AND g.user_id = NEW.user_id AND g.disclosure_json = a.disclosure_json)
   AND EXISTS(SELECT 1 FROM trial_periods t WHERE t.user_id = NEW.user_id AND t.started_at_ms = NEW.completed_at_ms)
   AND EXISTS(SELECT 1 FROM backup_recovery_credentials r WHERE r.user_id = NEW.user_id AND r.created_at_ms = NEW.completed_at_ms)
 ))
)
BEGIN SELECT RAISE(ABORT,'provider_completion_invalid'); END;
CREATE TRIGGER provider_completion_consumes_proof AFTER INSERT ON completed_provider_authentications
BEGIN
 UPDATE provider_authentication_attempts SET state = 'completed', user_id = NEW.user_id,
   cookie_digest = zeroblob(32), nonce = '', contact_email = NULL WHERE id = NEW.attempt_id;
END;
