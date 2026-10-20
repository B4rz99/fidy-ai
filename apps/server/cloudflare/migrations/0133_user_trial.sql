-- Retain the immutable original TrialPeriod on User.

DROP TRIGGER IF EXISTS trial_period_immutable_update;

DROP TRIGGER IF EXISTS provider_completion_requires_proof;

DROP TRIGGER IF EXISTS trial_period_immutable_delete;

DROP TRIGGER IF EXISTS erasure_fence_trial_periods_insert;

DROP TRIGGER IF EXISTS erasure_fence_trial_periods_update;

DROP TRIGGER IF EXISTS erasure_fence_trial_periods_delete;

DROP TRIGGER IF EXISTS erasure_fence_users_update;

ALTER TABLE users ADD COLUMN trial_started_at_ms INTEGER;

ALTER TABLE users ADD COLUMN trial_ends_at_ms INTEGER CHECK ((trial_started_at_ms IS NULL AND trial_ends_at_ms IS NULL) OR (trial_started_at_ms IS NOT NULL AND trial_ends_at_ms IS NOT NULL AND trial_ends_at_ms=trial_started_at_ms+604800000));

UPDATE users SET trial_started_at_ms=(SELECT started_at_ms FROM trial_periods WHERE user_id=users.id), trial_ends_at_ms=(SELECT ends_at_ms FROM trial_periods WHERE user_id=users.id);

DROP TABLE trial_periods;

CREATE TRIGGER provider_completion_requires_proof BEFORE INSERT ON completed_provider_authentications
WHEN NOT EXISTS (
 SELECT 1 FROM provider_authentication_attempts a
 JOIN provider_credentials c ON c.issuer=a.issuer AND c.subject=a.subject AND c.user_id=NEW.user_id
 JOIN browser_login_pairings p ON p.id=a.pairing_id AND p.state='ready' AND p.user_id=NEW.user_id
 WHERE a.id=NEW.attempt_id AND a.state='verified'
 AND a.expires_at_ms>NEW.completed_at_ms AND p.expires_at_ms>NEW.completed_at_ms AND p.wrong_attempts<5
 AND (NEW.created_user=0 OR (
 a.intent='signup' AND EXISTS(SELECT 1 FROM onboarding_consent_records g WHERE g.user_id=NEW.user_id
 AND ((a.handoff_id IS NULL AND g.id=a.id AND g.disclosure_json=a.disclosure_json)
 OR (a.handoff_id IS NOT NULL AND g.id=(SELECT exchange_id FROM whatsapp_provider_handoffs WHERE id=a.handoff_id))))
 AND EXISTS(SELECT 1 FROM users t WHERE t.id=NEW.user_id AND t.trial_started_at_ms=NEW.completed_at_ms)
 AND EXISTS(SELECT 1 FROM backup_recovery_credentials r WHERE r.user_id=NEW.user_id AND r.created_at_ms=NEW.completed_at_ms)
 ))
)
BEGIN SELECT RAISE(ABORT,'provider_completion_invalid'); END;

CREATE TRIGGER erasure_fence_users_update BEFORE UPDATE ON users
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.id=q.user_id) OR (OLD.id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='users'))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER users_trial_immutable_update BEFORE UPDATE OF trial_started_at_ms,trial_ends_at_ms ON users
WHEN OLD.trial_started_at_ms IS NOT NULL AND (NEW.trial_started_at_ms IS NOT OLD.trial_started_at_ms OR NEW.trial_ends_at_ms IS NOT OLD.trial_ends_at_ms)
BEGIN SELECT RAISE(ABORT,'trial_period_immutable'); END;

CREATE TRIGGER users_trial_immutable_delete BEFORE DELETE ON users
WHEN OLD.trial_started_at_ms IS NOT NULL AND NOT EXISTS(SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id
 WHERE p.store_id='users' AND p.user_id=OLD.id AND q.user_id=OLD.id AND q.state='Erasing')
BEGIN SELECT RAISE(ABORT,'trial_period_immutable'); END;
