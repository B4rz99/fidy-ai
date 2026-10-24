CREATE TABLE whatsapp_signup_invitations (
 id TEXT PRIMARY KEY NOT NULL,
 source_portfolio_id TEXT NOT NULL,
 source_bsuid TEXT NOT NULL,
 source_phone_number_id TEXT NOT NULL,
 source_message_id TEXT NOT NULL CHECK(length(source_message_id) BETWEEN 1 AND 256),
 source_phone TEXT,
 created_at_ms INTEGER NOT NULL,
 expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms=created_at_ms+600000),
 pairing_id TEXT UNIQUE REFERENCES browser_login_pairings(id) ON DELETE CASCADE,
 review_code TEXT UNIQUE,
 review_attempt_id TEXT,
 review_text TEXT,
 review_started_ms INTEGER,
 decision TEXT CHECK(decision IN ('confirmed','denied')),
 decision_message_id TEXT,
 confirmed_at_ms INTEGER,
 approved_at_ms INTEGER,
 consumed_at_ms INTEGER,
 CHECK ((pairing_id IS NULL)=(review_code IS NULL)),
 CHECK ((review_attempt_id IS NULL)=(review_text IS NULL) AND (review_attempt_id IS NULL)=(review_started_ms IS NULL)),
 CHECK ((decision IS NULL)=(decision_message_id IS NULL) AND (decision IS NULL)=(confirmed_at_ms IS NULL)),
 CHECK (decision IS NULL OR (review_attempt_id IS NOT NULL AND confirmed_at_ms>=review_started_ms AND confirmed_at_ms<expires_at_ms)),
 CHECK (approved_at_ms IS NULL OR (pairing_id IS NOT NULL AND approved_at_ms>=created_at_ms AND approved_at_ms<expires_at_ms)),
 CHECK (consumed_at_ms IS NULL OR (approved_at_ms IS NOT NULL AND consumed_at_ms=approved_at_ms))
) STRICT;
--> statement-breakpoint
CREATE INDEX whatsapp_signup_source ON whatsapp_signup_invitations(source_portfolio_id,source_bsuid,created_at_ms DESC);
--> statement-breakpoint
CREATE INDEX whatsapp_signup_expiry ON whatsapp_signup_invitations(expires_at_ms,id);
--> statement-breakpoint
CREATE TRIGGER whatsapp_signup_initial BEFORE INSERT ON whatsapp_signup_invitations
WHEN NEW.approved_at_ms IS NOT NULL OR NEW.consumed_at_ms IS NOT NULL OR NEW.pairing_id IS NOT NULL OR NEW.review_code IS NOT NULL OR NEW.review_attempt_id IS NOT NULL OR NEW.review_text IS NOT NULL OR NEW.review_started_ms IS NOT NULL OR NEW.decision IS NOT NULL OR NEW.decision_message_id IS NOT NULL OR NEW.confirmed_at_ms IS NOT NULL
BEGIN SELECT RAISE(ABORT,'whatsapp_signup_initial'); END;
--> statement-breakpoint
CREATE TRIGGER whatsapp_signup_immutable BEFORE UPDATE ON whatsapp_signup_invitations
WHEN NEW.id IS NOT OLD.id OR NEW.source_portfolio_id IS NOT OLD.source_portfolio_id
 OR NEW.source_bsuid IS NOT OLD.source_bsuid OR NEW.source_phone_number_id IS NOT OLD.source_phone_number_id
 OR NEW.source_message_id IS NOT OLD.source_message_id OR NEW.source_phone IS NOT OLD.source_phone
 OR NEW.created_at_ms IS NOT OLD.created_at_ms OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
 OR (OLD.pairing_id IS NOT NULL AND NEW.pairing_id IS NOT OLD.pairing_id)
 OR (OLD.decision IS NOT NULL AND (NEW.decision IS NOT OLD.decision OR NEW.review_code IS NOT OLD.review_code OR NEW.review_attempt_id IS NOT OLD.review_attempt_id OR NEW.review_text IS NOT OLD.review_text OR NEW.review_started_ms IS NOT OLD.review_started_ms OR NEW.decision_message_id IS NOT OLD.decision_message_id OR NEW.confirmed_at_ms IS NOT OLD.confirmed_at_ms))
 OR (OLD.approved_at_ms IS NOT NULL AND NEW.approved_at_ms IS NOT OLD.approved_at_ms)
 OR (OLD.consumed_at_ms IS NOT NULL AND NEW.consumed_at_ms IS NOT OLD.consumed_at_ms)
BEGIN SELECT RAISE(ABORT,'whatsapp_signup_immutable'); END;
--> statement-breakpoint
ALTER TABLE provider_authentication_attempts ADD COLUMN invitation_id TEXT REFERENCES whatsapp_signup_invitations(id) ON DELETE CASCADE;
--> statement-breakpoint
CREATE TRIGGER provider_invitation_immutable BEFORE UPDATE ON provider_authentication_attempts
WHEN NEW.invitation_id IS NOT OLD.invitation_id
BEGIN SELECT RAISE(ABORT,'provider_invitation_immutable'); END;
--> statement-breakpoint
CREATE TRIGGER provider_attempt_requires_invitation BEFORE INSERT ON provider_authentication_attempts
WHEN NEW.invitation_id IS NOT NULL AND (NEW.handoff_id IS NOT NULL OR NOT EXISTS(
 SELECT 1 FROM whatsapp_signup_invitations i WHERE i.id=NEW.invitation_id AND i.pairing_id=NEW.pairing_id
 AND i.expires_at_ms>NEW.created_at_ms AND i.approved_at_ms IS NULL AND i.consumed_at_ms IS NULL AND i.decision IS NULL
 AND NEW.intent='signup' AND NEW.disclosure_json IS NOT NULL AND NEW.consent_at_ms=NEW.created_at_ms
)) BEGIN SELECT RAISE(ABORT,'provider_invitation_invalid'); END;
--> statement-breakpoint
CREATE TRIGGER whatsapp_signup_approval_requires_provider BEFORE UPDATE OF approved_at_ms ON whatsapp_signup_invitations
WHEN OLD.approved_at_ms IS NULL AND NEW.approved_at_ms IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM provider_authentication_attempts a JOIN browser_login_pairings p ON p.id=a.pairing_id
 WHERE a.invitation_id=NEW.id AND a.pairing_id=NEW.pairing_id AND a.state='verified' AND a.intent='signup'
 AND a.id=NEW.review_attempt_id AND NEW.decision='confirmed' AND NEW.decision_message_id IS NOT NULL AND NEW.confirmed_at_ms>=NEW.review_started_ms AND NEW.confirmed_at_ms<=NEW.approved_at_ms
 AND a.expires_at_ms>NEW.approved_at_ms AND a.consent_at_ms IS NOT NULL AND a.disclosure_json IS NOT NULL
 AND p.state='pending_approval' AND p.expires_at_ms>NEW.approved_at_ms AND p.wrong_attempts<5
 AND NEW.expires_at_ms>NEW.approved_at_ms AND NEW.consumed_at_ms IS NULL
) BEGIN SELECT RAISE(ABORT,'whatsapp_signup_approval_invalid'); END;
--> statement-breakpoint
CREATE TRIGGER provider_invitation_completion_requires_approval BEFORE UPDATE OF completed_at_ms ON provider_authentication_attempts
WHEN OLD.completed_at_ms IS NULL AND NEW.completed_at_ms IS NOT NULL AND NEW.invitation_id IS NOT NULL
AND NOT EXISTS(
 SELECT 1 FROM whatsapp_signup_invitations i JOIN users u ON u.id=NEW.user_id
 WHERE i.id=NEW.invitation_id AND i.pairing_id=NEW.pairing_id AND i.approved_at_ms=NEW.completed_at_ms
 AND i.expires_at_ms>NEW.completed_at_ms AND i.consumed_at_ms IS NULL
 AND u.whatsapp_portfolio_id=i.source_portfolio_id AND u.whatsapp_bsuid=i.source_bsuid
) BEGIN SELECT RAISE(ABORT,'provider_invitation_approval_invalid'); END;
--> statement-breakpoint
CREATE TRIGGER whatsapp_signup_consumption_requires_completion BEFORE UPDATE OF consumed_at_ms ON whatsapp_signup_invitations
WHEN OLD.consumed_at_ms IS NULL AND NEW.consumed_at_ms IS NOT NULL AND NOT EXISTS(
 SELECT 1 FROM provider_authentication_attempts a WHERE a.invitation_id=NEW.id AND a.pairing_id=NEW.pairing_id
 AND a.state='completed' AND a.completed_at_ms=NEW.consumed_at_ms AND NEW.approved_at_ms=NEW.consumed_at_ms
) BEGIN SELECT RAISE(ABORT,'whatsapp_signup_consumption_invalid'); END;

--> statement-breakpoint
CREATE TRIGGER erasure_fence_whatsapp_signup_invitations_delete BEFORE DELETE ON whatsapp_signup_invitations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state <>'Draining' AND (EXISTS(SELECT 1 FROM browser_login_pairings p WHERE p.id=OLD.pairing_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='whatsapp_signup_invitations'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_whatsapp_signup_invitations_insert BEFORE INSERT ON whatsapp_signup_invitations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state <>'Draining' AND (EXISTS(SELECT 1 FROM browser_login_pairings p WHERE p.id=NEW.pairing_id AND p.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='whatsapp_signup_invitations'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint

CREATE TRIGGER erasure_fence_whatsapp_signup_invitations_update BEFORE UPDATE ON whatsapp_signup_invitations
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state <>'Draining' AND ((EXISTS(SELECT 1 FROM browser_login_pairings p WHERE p.id=NEW.pairing_id AND p.user_id=q.user_id)) OR (EXISTS(SELECT 1 FROM browser_login_pairings p WHERE p.id=OLD.pairing_id AND p.user_id=q.user_id))) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='whatsapp_signup_invitations'))
BEGIN
 SELECT RAISE(ABORT,'erasure_fenced');
END;
--> statement-breakpoint
