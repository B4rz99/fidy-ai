CREATE TABLE connection_grants (
  attempt_id TEXT PRIMARY KEY NOT NULL REFERENCES connection_attempts(id) ON DELETE RESTRICT,
  state TEXT NOT NULL CHECK(state IN ('claimed','quarantined','active','cleanup_required')),
  envelope TEXT CHECK(envelope IS NULL OR length(envelope) BETWEEN 1 AND 100000),
  expires_at_ms INTEGER,
  claimed_at_ms INTEGER NOT NULL,
  CHECK((state IN ('quarantined','active') AND envelope IS NOT NULL AND expires_at_ms IS NOT NULL) OR state IN ('claimed','cleanup_required'))
) STRICT;
--> statement-breakpoint

CREATE TABLE connection_accounts (
  id TEXT PRIMARY KEY NOT NULL CHECK(length(id)=36),
  connection_id TEXT NOT NULL REFERENCES connections(id) ON DELETE RESTRICT,
  provider_reference TEXT NOT NULL CHECK(length(provider_reference) BETWEEN 1 AND 256),
  grant_attempt_id TEXT NOT NULL REFERENCES connection_grants(attempt_id) ON DELETE RESTRICT,
  UNIQUE(connection_id,provider_reference)
) STRICT;
--> statement-breakpoint

CREATE INDEX connection_grant_recovery ON connection_grants(state,claimed_at_ms);
--> statement-breakpoint

CREATE UNIQUE INDEX connection_authorization_state ON connection_authorizations(state_digest);
--> statement-breakpoint

CREATE TRIGGER connection_grant_binding BEFORE INSERT ON connection_grants
WHEN NEW.state!='claimed' OR NEW.envelope IS NOT NULL OR NEW.expires_at_ms IS NOT NULL OR NOT EXISTS(
 SELECT 1 FROM connection_attempts a JOIN connection_authorizations b ON b.attempt_id=a.id JOIN connections c ON c.id=a.connection_id
 WHERE a.id=NEW.attempt_id AND a.status='consumed' AND a.prepared_session_id IS NOT NULL
 AND a.expires_at_ms>NEW.claimed_at_ms AND b.phase='prepared' AND b.consent_id IS NOT NULL AND c.state='Connecting'
 AND NOT EXISTS(SELECT 1 FROM connection_attempts newer WHERE newer.connection_id=c.id AND newer.rowid>a.rowid))
BEGIN SELECT RAISE(ABORT,'connection_grant_binding'); END;
--> statement-breakpoint

CREATE TRIGGER connection_grant_transition BEFORE UPDATE ON connection_grants
WHEN NEW.attempt_id IS NOT OLD.attempt_id OR NEW.claimed_at_ms IS NOT OLD.claimed_at_ms
 OR NOT ((OLD.state='claimed' AND NEW.state IN ('quarantined','cleanup_required'))
  OR (OLD.state='quarantined' AND NEW.state IN ('active','cleanup_required'))
  OR (OLD.state='active' AND NEW.state='cleanup_required'))
 OR (OLD.envelope IS NOT NULL AND (NEW.envelope IS NOT OLD.envelope OR NEW.expires_at_ms IS NOT OLD.expires_at_ms))
BEGIN SELECT RAISE(ABORT,'connection_grant_transition'); END;
--> statement-breakpoint

CREATE TRIGGER connection_account_binding_insert BEFORE INSERT ON connection_accounts
WHEN NOT EXISTS(SELECT 1 FROM connection_grants g JOIN connection_attempts a ON a.id=g.attempt_id WHERE g.attempt_id=NEW.grant_attempt_id AND a.connection_id=NEW.connection_id AND g.state='active')
BEGIN SELECT RAISE(ABORT,'connection_account_binding'); END;

--> statement-breakpoint

CREATE TRIGGER erasure_fence_connection_grants_insert BEFORE INSERT ON connection_grants
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state<>'Draining' AND EXISTS(SELECT 1 FROM connections c JOIN connection_attempts a ON a.connection_id=c.id WHERE c.user_id=q.user_id AND (a.id=NEW.attempt_id))
 AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='connection_grants'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

--> statement-breakpoint

CREATE TRIGGER erasure_fence_connection_grants_update BEFORE UPDATE ON connection_grants
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state<>'Draining' AND EXISTS(SELECT 1 FROM connections c JOIN connection_attempts a ON a.connection_id=c.id WHERE c.user_id=q.user_id AND (a.id=NEW.attempt_id OR a.id=OLD.attempt_id))
 AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='connection_grants'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

--> statement-breakpoint

CREATE TRIGGER erasure_fence_connection_grants_delete BEFORE DELETE ON connection_grants
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state<>'Draining' AND EXISTS(SELECT 1 FROM connections c JOIN connection_attempts a ON a.connection_id=c.id WHERE c.user_id=q.user_id AND (a.id=OLD.attempt_id))
 AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='connection_grants'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

--> statement-breakpoint

CREATE TRIGGER erasure_fence_connection_accounts_insert BEFORE INSERT ON connection_accounts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state<>'Draining' AND EXISTS(SELECT 1 FROM connections c WHERE c.user_id=q.user_id AND (c.id=NEW.connection_id))
 AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='connection_accounts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

--> statement-breakpoint

CREATE TRIGGER erasure_fence_connection_accounts_update BEFORE UPDATE ON connection_accounts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state<>'Draining' AND EXISTS(SELECT 1 FROM connections c WHERE c.user_id=q.user_id AND (c.id=NEW.connection_id OR c.id=OLD.connection_id))
 AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='connection_accounts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

--> statement-breakpoint

CREATE TRIGGER erasure_fence_connection_accounts_delete BEFORE DELETE ON connection_accounts
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state<>'Draining' AND EXISTS(SELECT 1 FROM connections c WHERE c.user_id=q.user_id AND (c.id=OLD.connection_id))
 AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='connection_accounts'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

--> statement-breakpoint

CREATE TRIGGER connection_account_binding_update BEFORE UPDATE ON connection_accounts
WHEN NEW.id IS NOT OLD.id OR NEW.connection_id IS NOT OLD.connection_id OR NEW.provider_reference IS NOT OLD.provider_reference
 OR NOT EXISTS(SELECT 1 FROM connection_grants g JOIN connection_attempts a ON a.id=g.attempt_id WHERE g.attempt_id=NEW.grant_attempt_id AND a.connection_id=NEW.connection_id AND g.state='active')
BEGIN SELECT RAISE(ABORT,'connection_account_binding'); END;
