-- A queued receipt was published under active Consent. Withdrawal does not admit new receipts
-- or publish a storing reservation; it permits only bounded continuation of already queued work.
DROP TRIGGER forwarded_email_publication_authority;
CREATE TRIGGER forwarded_email_publication_authority BEFORE UPDATE OF state ON forwarded_email_receipts
WHEN NEW.state = 'queued' AND (
  NOT EXISTS (SELECT 1 FROM onboarding_consent_records WHERE user_id = NEW.user_id)
  OR (OLD.state <> 'queued' AND EXISTS
    (SELECT 1 FROM consent_user_revocations WHERE user_id = NEW.user_id)))
BEGIN SELECT RAISE(ABORT, 'forwarded_email_consent'); END;

DROP TRIGGER forwarded_email_outcome_consent;
CREATE TRIGGER forwarded_email_outcome_consent BEFORE INSERT ON forwarded_email_outcomes
WHEN (NEW.outcome <> 'needs-review' OR NOT EXISTS
    (SELECT 1 FROM forwarded_email_needs_review e WHERE e.id = NEW.review_id
      AND e.reason = 'consent-revoked')) AND (
  NOT EXISTS (SELECT 1 FROM onboarding_consent_records WHERE user_id = NEW.user_id)
  OR (EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = NEW.user_id)
    AND NOT EXISTS (SELECT 1 FROM forwarded_email_receipts
      WHERE id = NEW.receipt_id AND user_id = NEW.user_id AND state = 'queued'
        AND expires_at_ms > NEW.completed_at_ms)))
  OR (EXISTS (SELECT 1 FROM forwarded_email_needs_review e
    WHERE e.id = NEW.review_id AND e.reason = 'consent-revoked')
    AND NOT EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = NEW.user_id))
  OR NOT EXISTS (SELECT 1 FROM forwarded_email_receipts
    WHERE id = NEW.receipt_id AND user_id = NEW.user_id
      AND (state = 'queued' OR (state = 'storing' AND NEW.outcome = 'needs-review'))
      AND (expires_at_ms > NEW.completed_at_ms OR (NEW.outcome = 'needs-review'
        AND EXISTS (SELECT 1 FROM forwarded_email_needs_review e
          WHERE e.id = NEW.review_id AND e.reason IN ('processing-interrupted', 'consent-revoked')))))
BEGIN SELECT RAISE(ABORT, 'forwarded_email_authority'); END;
