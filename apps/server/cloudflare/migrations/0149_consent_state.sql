PRAGMA defer_foreign_keys=ON;

DROP TRIGGER IF EXISTS consent_user_revocations_no_update;

DROP TRIGGER IF EXISTS erasure_fence_consent_user_revocations_insert;

DROP TRIGGER IF EXISTS erasure_fence_consent_user_revocations_update;

DROP TRIGGER IF EXISTS erasure_fence_consent_user_revocations_delete;

DROP TRIGGER IF EXISTS erasure_preserve_consent_user_revocations_delete;

DROP TRIGGER IF EXISTS consent_user_revocation_requires_grant;

DROP TRIGGER IF EXISTS processing_consent_withdrawal_history;

DROP TRIGGER IF EXISTS processing_consent_renewal_requires_authority;

DROP TRIGGER IF EXISTS consent_user_revocations_requires_renewal;

DROP TRIGGER IF EXISTS hosted_turn_requires_consent;

DROP TRIGGER IF EXISTS forwarded_email_authority;

DROP TRIGGER IF EXISTS forwarded_email_publication_authority;

DROP TRIGGER IF EXISTS forwarded_email_outcome_consent;

INSERT INTO sql_assertions(scope,accepted) SELECT 'migration_consent_state',NOT EXISTS(SELECT id,user_id,grant_record_id,session_id,occurred_at_ms FROM consent_user_revocations EXCEPT SELECT id,user_id,grant_record_id,session_id,occurred_at_ms FROM (SELECT w.id,w.user_id,w.grant_record_id,w.session_id,w.occurred_at_ms FROM consent_history w WHERE w.record_type='processing_withdrawal' AND NOT EXISTS(SELECT 1 FROM consent_history n WHERE n.record_type='processing_renewal' AND n.withdrawal_id=w.id AND n.user_id=w.user_id))) AND NOT EXISTS(SELECT id,user_id,grant_record_id,session_id,occurred_at_ms FROM (SELECT w.id,w.user_id,w.grant_record_id,w.session_id,w.occurred_at_ms FROM consent_history w WHERE w.record_type='processing_withdrawal' AND NOT EXISTS(SELECT 1 FROM consent_history n WHERE n.record_type='processing_renewal' AND n.withdrawal_id=w.id AND n.user_id=w.user_id)) EXCEPT SELECT id,user_id,grant_record_id,session_id,occurred_at_ms FROM consent_user_revocations);

DROP TABLE consent_user_revocations;

CREATE TRIGGER processing_consent_renewal_requires_authority BEFORE INSERT ON consent_history
WHEN NEW.record_type='processing_renewal' AND ( NOT EXISTS (
  SELECT 1 FROM (SELECT w.id,w.user_id,w.grant_record_id,w.session_id,w.occurred_at_ms FROM consent_history w WHERE w.record_type='processing_withdrawal' AND NOT EXISTS(SELECT 1 FROM consent_history n WHERE n.record_type='processing_renewal' AND n.withdrawal_id=w.id AND n.user_id=w.user_id)) r JOIN (SELECT * FROM consent_history WHERE record_type='processing_grant') g ON g.id=r.grant_record_id
  JOIN web_sessions w ON w.user_id=r.user_id
  WHERE r.id=NEW.withdrawal_id AND r.user_id=NEW.user_id AND g.user_id=NEW.user_id
    AND g.id=NEW.grant_record_id AND g.disclosure_json=NEW.disclosure_json
    AND r.occurred_at_ms<=NEW.accepted_at_ms AND w.id=NEW.session_id AND w.revoked_at_ms IS NULL
    AND w.fresh_until_ms>NEW.accepted_at_ms AND w.idle_expires_at_ms>NEW.accepted_at_ms
    AND w.hard_expires_at_ms>NEW.accepted_at_ms
)
) BEGIN SELECT RAISE(ABORT,'consent_renewal_requires_authority'); END;

CREATE TRIGGER hosted_turn_requires_consent BEFORE INSERT ON hosted_turns
WHEN NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records WHERE user_id = NEW.user_id)
  OR EXISTS (SELECT 1 FROM (SELECT w.id,w.user_id,w.grant_record_id,w.session_id,w.occurred_at_ms FROM consent_history w WHERE w.record_type='processing_withdrawal' AND NOT EXISTS(SELECT 1 FROM consent_history n WHERE n.record_type='processing_renewal' AND n.withdrawal_id=w.id AND n.user_id=w.user_id)) AS consent_user_revocations WHERE user_id = NEW.user_id)
BEGIN
 SELECT RAISE(ABORT, 'hosted_turn_consent_required');
END;

CREATE TRIGGER forwarded_email_authority BEFORE INSERT ON forwarded_email_receipts
WHEN NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records WHERE user_id = NEW.user_id)
  OR EXISTS (SELECT 1 FROM (SELECT w.id,w.user_id,w.grant_record_id,w.session_id,w.occurred_at_ms FROM consent_history w WHERE w.record_type='processing_withdrawal' AND NOT EXISTS(SELECT 1 FROM consent_history n WHERE n.record_type='processing_renewal' AND n.withdrawal_id=w.id AND n.user_id=w.user_id)) AS consent_user_revocations WHERE user_id = NEW.user_id)
BEGIN
 SELECT RAISE(ABORT, 'forwarded_email_consent');
END;

CREATE TRIGGER forwarded_email_publication_authority BEFORE UPDATE OF state ON forwarded_email_receipts
WHEN NEW.state = 'queued' AND (
  NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records WHERE user_id = NEW.user_id)
  OR (OLD.state <> 'queued' AND EXISTS
    (SELECT 1 FROM (SELECT w.id,w.user_id,w.grant_record_id,w.session_id,w.occurred_at_ms FROM consent_history w WHERE w.record_type='processing_withdrawal' AND NOT EXISTS(SELECT 1 FROM consent_history n WHERE n.record_type='processing_renewal' AND n.withdrawal_id=w.id AND n.user_id=w.user_id)) AS consent_user_revocations WHERE user_id = NEW.user_id)))
BEGIN
 SELECT RAISE(ABORT, 'forwarded_email_consent');
END;

CREATE TRIGGER forwarded_email_outcome_consent BEFORE UPDATE OF outcome ON forwarded_email_receipts
WHEN OLD.outcome IS NULL AND NEW.outcome IS NOT NULL AND ((NEW.outcome <> 'needs-review' OR NOT (NEW.review_id=NEW.outcome_review_id AND NEW.review_reason='consent-revoked')) AND (
  NOT EXISTS (SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS onboarding_consent_records WHERE user_id = NEW.user_id)
  OR (EXISTS (SELECT 1 FROM (SELECT w.id,w.user_id,w.grant_record_id,w.session_id,w.occurred_at_ms FROM consent_history w WHERE w.record_type='processing_withdrawal' AND NOT EXISTS(SELECT 1 FROM consent_history n WHERE n.record_type='processing_renewal' AND n.withdrawal_id=w.id AND n.user_id=w.user_id)) AS consent_user_revocations WHERE user_id = NEW.user_id)
    AND NOT EXISTS (SELECT 1 FROM forwarded_email_receipts
      WHERE id = NEW.id AND user_id = NEW.user_id AND state = 'queued'
        AND expires_at_ms > NEW.outcome_completed_at_ms)))
  OR ((NEW.review_id=NEW.outcome_review_id AND NEW.review_reason='consent-revoked')
    AND NOT EXISTS (SELECT 1 FROM (SELECT w.id,w.user_id,w.grant_record_id,w.session_id,w.occurred_at_ms FROM consent_history w WHERE w.record_type='processing_withdrawal' AND NOT EXISTS(SELECT 1 FROM consent_history n WHERE n.record_type='processing_renewal' AND n.withdrawal_id=w.id AND n.user_id=w.user_id)) AS consent_user_revocations WHERE user_id = NEW.user_id))
  OR NOT EXISTS (SELECT 1 FROM forwarded_email_receipts
    WHERE id = NEW.id AND user_id = NEW.user_id
      AND (state = 'queued' OR (state = 'storing' AND NEW.outcome = 'needs-review'))
      AND (expires_at_ms > NEW.outcome_completed_at_ms OR (NEW.outcome = 'needs-review'
        AND (NEW.review_id=NEW.outcome_review_id AND NEW.review_reason IN ('processing-interrupted','consent-revoked')))))
)
BEGIN
 SELECT RAISE(ABORT, 'forwarded_email_authority');
END;

CREATE TRIGGER consent_user_revocation_requires_grant BEFORE INSERT ON consent_history
WHEN NEW.record_type='processing_withdrawal' AND NOT EXISTS (
  SELECT 1 FROM (SELECT * FROM consent_history WHERE record_type='processing_grant') AS g
  JOIN web_sessions AS w ON w.user_id = g.user_id
  WHERE g.id = NEW.grant_record_id AND g.user_id = NEW.user_id
    AND w.id = NEW.session_id AND w.revoked_at_ms IS NULL
    AND w.idle_expires_at_ms > NEW.occurred_at_ms AND w.hard_expires_at_ms > NEW.occurred_at_ms
)
BEGIN SELECT RAISE(ABORT, 'consent_revocation_requires_user_session'); END;

CREATE TRIGGER processing_withdrawal_once BEFORE INSERT ON consent_history WHEN NEW.record_type='processing_withdrawal' AND EXISTS(SELECT 1 FROM (SELECT w.id,w.user_id,w.grant_record_id,w.session_id,w.occurred_at_ms FROM consent_history w WHERE w.record_type='processing_withdrawal' AND NOT EXISTS(SELECT 1 FROM consent_history n WHERE n.record_type='processing_renewal' AND n.withdrawal_id=w.id AND n.user_id=w.user_id)) current WHERE current.user_id=NEW.user_id) BEGIN SELECT RAISE(IGNORE); END;

CREATE INDEX consent_history_active_withdrawal ON consent_history(user_id,id) WHERE record_type='processing_withdrawal';

DELETE FROM sql_assertions WHERE scope='migration_consent_state';

PRAGMA defer_foreign_keys=OFF;
