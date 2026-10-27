CREATE TABLE connection_authorizations (
  attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES connection_attempts(id) ON DELETE CASCADE,
  intent_json TEXT NOT NULL CHECK(json_valid(intent_json)),
  consent_id TEXT CHECK(consent_id IS NULL OR length(consent_id) BETWEEN 1 AND 128),
  verifier TEXT CHECK(verifier IS NULL OR length(verifier)=43),
  state_digest TEXT NOT NULL CHECK(length(state_digest)=43),
  phase TEXT NOT NULL CHECK(phase IN ('preparing','prepared','failed')),
  handoff_url TEXT,
  expires_at_ms INTEGER NOT NULL,
  CHECK((phase='prepared' AND handoff_url IS NOT NULL) OR (phase!='prepared' AND handoff_url IS NULL)),
  CHECK((phase='failed' AND verifier IS NULL) OR (phase!='failed' AND verifier IS NOT NULL))
) STRICT;
--> statement-breakpoint

CREATE TRIGGER connection_authorization_binding BEFORE INSERT ON connection_authorizations
WHEN NEW.phase!='preparing' OR NEW.consent_id IS NOT NULL OR NOT EXISTS(
  SELECT 1 FROM connection_attempts a WHERE a.id=NEW.attempt_id AND a.status='consumed'
    AND a.prepared_session_id IS NOT NULL AND NEW.expires_at_ms=a.expires_at_ms)
BEGIN SELECT RAISE(ABORT,'connection_authorization_binding'); END;
--> statement-breakpoint

CREATE TRIGGER connection_authorization_transition BEFORE UPDATE ON connection_authorizations
WHEN OLD.phase='failed' OR (NEW.phase='preparing' AND NOT(OLD.phase='preparing' AND OLD.consent_id IS NULL AND NEW.consent_id IS NOT NULL)) OR (OLD.phase='prepared' AND NEW.phase!='failed')
  OR NEW.intent_json IS NOT OLD.intent_json OR (OLD.consent_id IS NOT NULL AND NEW.consent_id IS NOT OLD.consent_id)
  OR NEW.attempt_id IS NOT OLD.attempt_id OR (NEW.verifier IS NOT OLD.verifier AND NEW.phase!='failed')
  OR NEW.state_digest IS NOT OLD.state_digest
  OR NEW.expires_at_ms>OLD.expires_at_ms
BEGIN SELECT RAISE(ABORT,'connection_authorization_transition'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_connection_authorizations_insert BEFORE INSERT ON connection_authorizations
WHEN EXISTS(SELECT 1 FROM erasure_requests q JOIN connections c ON c.user_id=q.user_id JOIN connection_attempts a ON a.connection_id=c.id
 WHERE a.id=NEW.attempt_id AND q.state<>'Draining' AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='connection_authorizations'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_connection_authorizations_update BEFORE UPDATE ON connection_authorizations
WHEN EXISTS(SELECT 1 FROM erasure_requests q JOIN connections c ON c.user_id=q.user_id JOIN connection_attempts a ON a.connection_id=c.id
 WHERE (a.id=NEW.attempt_id OR a.id=OLD.attempt_id) AND q.state<>'Draining' AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='connection_authorizations'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_connection_authorizations_delete BEFORE DELETE ON connection_authorizations
WHEN EXISTS(SELECT 1 FROM erasure_requests q JOIN connections c ON c.user_id=q.user_id JOIN connection_attempts a ON a.connection_id=c.id
 WHERE a.id=OLD.attempt_id AND q.state<>'Draining' AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='connection_authorizations'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;
