-- Erasure attribution survives retirement; it never supplies login authority.
ALTER TABLE browser_login_pairings ADD COLUMN erasure_user_id TEXT REFERENCES users(id);
--> statement-breakpoint

UPDATE browser_login_pairings SET erasure_user_id = COALESCE(user_id, approval_user_id);
--> statement-breakpoint

CREATE TRIGGER browser_login_pairing_erasure_attribution AFTER UPDATE OF state ON browser_login_pairings
WHEN OLD.state = 'pending_approval' AND NEW.state = 'ready'
BEGIN
  UPDATE browser_login_pairings SET erasure_user_id = NEW.user_id WHERE id = NEW.id;
END;
--> statement-breakpoint

CREATE TRIGGER browser_login_pairing_erasure_attribution_immutable BEFORE UPDATE OF erasure_user_id ON browser_login_pairings
WHEN OLD.erasure_user_id IS NOT NULL AND NEW.erasure_user_id IS NOT OLD.erasure_user_id
BEGIN
  SELECT RAISE(ABORT, 'browser_login_pairing_erasure_attribution_immutable');
END;
--> statement-breakpoint

CREATE INDEX browser_login_pairings_ready_user ON browser_login_pairings(user_id)
WHERE state = 'ready';
--> statement-breakpoint

CREATE TRIGGER browser_login_pairing_order_immutable BEFORE UPDATE ON browser_login_pairings
WHEN NEW.rowid <> OLD.rowid
BEGIN
  SELECT RAISE(ABORT, 'browser_login_pairing_order_immutable');
END;
--> statement-breakpoint

CREATE TRIGGER browser_login_pairing_supersede AFTER UPDATE OF state ON browser_login_pairings
WHEN OLD.state = 'pending_approval' AND NEW.state = 'ready'
BEGIN
  UPDATE browser_login_pairings SET state = 'invalidated', user_id = NULL
  WHERE state = 'ready' AND user_id = NEW.user_id AND rowid < NEW.rowid;
END;

--> statement-breakpoint

DROP TRIGGER erasure_fence_browser_login_pairings_delete;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_browser_login_pairings_delete BEFORE DELETE ON browser_login_pairings
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state <>'Draining' AND ((OLD.user_id=q.user_id OR OLD.approval_user_id=q.user_id OR OLD.erasure_user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_login_pairings'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

--> statement-breakpoint

DROP TRIGGER erasure_fence_browser_login_pairings_insert;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_browser_login_pairings_insert BEFORE INSERT ON browser_login_pairings
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state <>'Draining' AND ((NEW.user_id=q.user_id OR NEW.approval_user_id=q.user_id OR NEW.erasure_user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_login_pairings'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

--> statement-breakpoint

DROP TRIGGER erasure_fence_browser_login_pairings_update;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_browser_login_pairings_update BEFORE UPDATE ON browser_login_pairings
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state <>'Draining' AND (((NEW.user_id=q.user_id OR NEW.approval_user_id=q.user_id OR NEW.erasure_user_id=q.user_id)) OR ((OLD.user_id=q.user_id OR OLD.approval_user_id=q.user_id OR OLD.erasure_user_id=q.user_id))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='browser_login_pairings')) AND NOT(NEW.erasure_user_id IS OLD.erasure_user_id AND NEW.id IS OLD.id AND NEW.public_code IS OLD.public_code AND NEW.verifier_digest IS OLD.verifier_digest AND NEW.user_id IS OLD.user_id AND NEW.state IS OLD.state AND NEW.created_at_ms IS OLD.created_at_ms AND NEW.expires_at_ms IS OLD.expires_at_ms AND NEW.wrong_attempts IS OLD.wrong_attempts AND NEW.last_poll_at_ms IS OLD.last_poll_at_ms AND NEW.minimum_poll_interval_seconds IS OLD.minimum_poll_interval_seconds AND NEW.approval_portfolio_id IS OLD.approval_portfolio_id AND NEW.approval_message_id IS OLD.approval_message_id AND NEW.approval_user_id IS OLD.approval_user_id)
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

--> statement-breakpoint

DROP TRIGGER erasure_fence_whatsapp_provider_handoffs_delete;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_whatsapp_provider_handoffs_delete BEFORE DELETE ON whatsapp_provider_handoffs
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state <>'Draining' AND (EXISTS(SELECT 1 FROM browser_login_pairings p WHERE p.id=OLD.pairing_id AND (p.user_id=q.user_id OR p.erasure_user_id=q.user_id))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='whatsapp_provider_handoffs'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

--> statement-breakpoint

DROP TRIGGER erasure_fence_whatsapp_provider_handoffs_insert;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_whatsapp_provider_handoffs_insert BEFORE INSERT ON whatsapp_provider_handoffs
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state <>'Draining' AND (EXISTS(SELECT 1 FROM browser_login_pairings p WHERE p.id=NEW.pairing_id AND (p.user_id=q.user_id OR p.erasure_user_id=q.user_id))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='whatsapp_provider_handoffs'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

--> statement-breakpoint

DROP TRIGGER erasure_fence_whatsapp_provider_handoffs_update;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_whatsapp_provider_handoffs_update BEFORE UPDATE ON whatsapp_provider_handoffs
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state <>'Draining' AND ((EXISTS(SELECT 1 FROM browser_login_pairings p WHERE p.id=NEW.pairing_id AND (p.user_id=q.user_id OR p.erasure_user_id=q.user_id))) OR (EXISTS(SELECT 1 FROM browser_login_pairings p WHERE p.id=OLD.pairing_id AND (p.user_id=q.user_id OR p.erasure_user_id=q.user_id)))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='whatsapp_provider_handoffs'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

--> statement-breakpoint

DROP TRIGGER erasure_fence_whatsapp_signup_invitations_delete;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_whatsapp_signup_invitations_delete BEFORE DELETE ON whatsapp_signup_invitations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state <>'Draining' AND (EXISTS(SELECT 1 FROM browser_login_pairings p WHERE p.id=OLD.pairing_id AND (p.user_id=q.user_id OR p.erasure_user_id=q.user_id))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='whatsapp_signup_invitations'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

--> statement-breakpoint

DROP TRIGGER erasure_fence_whatsapp_signup_invitations_insert;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_whatsapp_signup_invitations_insert BEFORE INSERT ON whatsapp_signup_invitations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state <>'Draining' AND (EXISTS(SELECT 1 FROM browser_login_pairings p WHERE p.id=NEW.pairing_id AND (p.user_id=q.user_id OR p.erasure_user_id=q.user_id))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='whatsapp_signup_invitations'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;

--> statement-breakpoint

DROP TRIGGER erasure_fence_whatsapp_signup_invitations_update;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_whatsapp_signup_invitations_update BEFORE UPDATE ON whatsapp_signup_invitations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state <>'Draining' AND ((EXISTS(SELECT 1 FROM browser_login_pairings p WHERE p.id=NEW.pairing_id AND (p.user_id=q.user_id OR p.erasure_user_id=q.user_id))) OR (EXISTS(SELECT 1 FROM browser_login_pairings p WHERE p.id=OLD.pairing_id AND (p.user_id=q.user_id OR p.erasure_user_id=q.user_id)))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='whatsapp_signup_invitations'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
