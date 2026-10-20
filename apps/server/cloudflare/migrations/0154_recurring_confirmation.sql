-- Store the immutable first-confirmation snapshot on its owning series.
-- Preserve the original confirmation rowid as the digest sequence, independently of series rowid.
DROP TRIGGER IF EXISTS erasure_fence_recurring_series_update;

ALTER TABLE recurring_series ADD COLUMN confirmation_id TEXT;
ALTER TABLE recurring_series ADD COLUMN confirmed_at TEXT;
ALTER TABLE recurring_series ADD COLUMN confirmation_context_json TEXT;
ALTER TABLE recurring_series ADD COLUMN confirmation_json TEXT;
ALTER TABLE recurring_series ADD COLUMN digest_excluded INTEGER CHECK(digest_excluded IN(0,1));
ALTER TABLE recurring_series ADD COLUMN confirmation_sequence INTEGER CHECK(
 (confirmation_id IS NULL AND confirmed_at IS NULL AND confirmation_context_json IS NULL
  AND confirmation_json IS NULL AND digest_excluded IS NULL AND confirmation_sequence IS NULL)
 OR (confirmation_id IS NOT NULL AND confirmed_at IS NOT NULL AND confirmation_context_json IS NOT NULL
  AND confirmation_json IS NOT NULL AND digest_excluded IS NOT NULL AND confirmation_sequence IS NOT NULL
  AND confirmation_sequence>0));

UPDATE recurring_series AS s SET (confirmation_id,confirmed_at,confirmation_context_json,confirmation_json,digest_excluded,confirmation_sequence)=
 (SELECT id,confirmed_at,context_json,confirmation_json,digest_excluded,rowid FROM recurring_confirmations c WHERE c.user_id=s.user_id AND c.series_id=s.id)
WHERE EXISTS(SELECT 1 FROM recurring_confirmations c WHERE c.user_id=s.user_id AND c.series_id=s.id);

DROP TRIGGER erasure_preserve_recurring_confirmations_delete;
DROP TABLE recurring_confirmations;

CREATE UNIQUE INDEX recurring_confirmation_identity ON recurring_series(user_id,confirmation_id) WHERE confirmation_id IS NOT NULL;
CREATE UNIQUE INDEX recurring_confirmation_sequence ON recurring_series(confirmation_sequence) WHERE confirmation_sequence IS NOT NULL;
CREATE INDEX recurring_confirmation_page ON recurring_series(user_id,confirmation_sequence) WHERE confirmation_sequence IS NOT NULL;
CREATE INDEX recurring_confirmation_order ON recurring_series(user_id,confirmed_at,confirmation_id) WHERE confirmation_id IS NOT NULL;

CREATE TRIGGER erasure_fence_recurring_series_update BEFORE UPDATE ON recurring_series
WHEN EXISTS(SELECT 1 FROM erasure_requests q WHERE q.state NOT IN('AwaitingReview','Draining') AND ((NEW.user_id=q.user_id) OR (OLD.user_id=q.user_id)) AND NOT EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=q.user_id AND p.request_id=q.id AND p.store_id='recurring_series') AND NOT (EXISTS(SELECT 1 FROM erasure_permits p WHERE p.user_id=OLD.user_id AND p.store_id='recurring_confirmations' AND p.request_id=q.id) AND NEW.user_id IS OLD.user_id AND NEW.id IS OLD.id AND NEW.currency IS OLD.currency AND NEW.counterparty_key IS OLD.counterparty_key AND NEW.series_json IS OLD.series_json AND NEW.evidence_json IS OLD.evidence_json AND NEW.reference_json IS OLD.reference_json AND NEW.valid IS OLD.valid))
BEGIN SELECT RAISE(ABORT,'erasure_fenced'); END;

CREATE TRIGGER recurring_confirmation_no_update BEFORE UPDATE ON recurring_series
WHEN OLD.confirmation_id IS NOT NULL AND (NEW.confirmation_id IS NOT OLD.confirmation_id OR NEW.confirmed_at IS NOT OLD.confirmed_at OR NEW.confirmation_context_json IS NOT OLD.confirmation_context_json OR NEW.confirmation_json IS NOT OLD.confirmation_json OR NEW.digest_excluded IS NOT OLD.digest_excluded OR NEW.confirmation_sequence IS NOT OLD.confirmation_sequence OR NEW.user_id IS NOT OLD.user_id OR NEW.id IS NOT OLD.id)
 AND NOT (NEW.confirmation_id IS NULL AND NEW.confirmed_at IS NULL AND NEW.confirmation_context_json IS NULL AND NEW.confirmation_json IS NULL AND NEW.digest_excluded IS NULL AND NEW.confirmation_sequence IS NULL AND NEW.user_id IS OLD.user_id AND NEW.id IS OLD.id AND NEW.currency IS OLD.currency AND NEW.counterparty_key IS OLD.counterparty_key AND NEW.series_json IS OLD.series_json AND NEW.evidence_json IS OLD.evidence_json AND NEW.reference_json IS OLD.reference_json AND NEW.valid IS OLD.valid AND EXISTS(
  SELECT 1 FROM erasure_permits p JOIN erasure_requests q ON q.id=p.request_id AND q.user_id=p.user_id
  WHERE p.user_id=OLD.user_id AND p.store_id='recurring_confirmations'))
BEGIN SELECT RAISE(ABORT,'recurring_confirmation_immutable'); END;

-- The confirmation purpose must be disposed before the series purpose.
CREATE TRIGGER recurring_confirmation_before_series_delete BEFORE DELETE ON recurring_series
WHEN OLD.confirmation_id IS NOT NULL
BEGIN SELECT RAISE(ABORT,'recurring_confirmation_pending'); END;
