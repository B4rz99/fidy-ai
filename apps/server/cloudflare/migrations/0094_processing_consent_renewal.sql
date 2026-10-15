-- Withdrawal history remains immutable; consent_user_revocations is the current cutoff.
CREATE TABLE processing_consent_withdrawal_records (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  grant_record_id TEXT NOT NULL REFERENCES onboarding_consent_records(id),
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  occurred_at_ms INTEGER NOT NULL
) STRICT;
INSERT INTO processing_consent_withdrawal_records SELECT * FROM consent_user_revocations;
CREATE INDEX processing_consent_withdrawal_user ON processing_consent_withdrawal_records(user_id,occurred_at_ms);
CREATE TRIGGER processing_consent_withdrawal_no_update BEFORE UPDATE ON processing_consent_withdrawal_records
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
CREATE TRIGGER processing_consent_withdrawal_no_delete BEFORE DELETE ON processing_consent_withdrawal_records
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
CREATE TRIGGER processing_consent_withdrawal_history AFTER INSERT ON consent_user_revocations
BEGIN INSERT INTO processing_consent_withdrawal_records VALUES(NEW.id,NEW.user_id,NEW.grant_record_id,NEW.session_id,NEW.occurred_at_ms); END;
CREATE TABLE processing_consent_renewals (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  withdrawal_id TEXT NOT NULL UNIQUE REFERENCES processing_consent_withdrawal_records(id),
  grant_record_id TEXT NOT NULL REFERENCES onboarding_consent_records(id),
  session_id TEXT NOT NULL REFERENCES web_sessions(id),
  disclosure_json TEXT NOT NULL CHECK(json_valid(disclosure_json)),
  accepted_at_ms INTEGER NOT NULL
) STRICT;
CREATE TRIGGER processing_consent_renewal_requires_authority BEFORE INSERT ON processing_consent_renewals
WHEN NOT EXISTS (
  SELECT 1 FROM consent_user_revocations r JOIN onboarding_consent_records g ON g.id=r.grant_record_id
  JOIN web_sessions w ON w.user_id=r.user_id
  WHERE r.id=NEW.withdrawal_id AND r.user_id=NEW.user_id AND g.user_id=NEW.user_id
    AND g.id=NEW.grant_record_id AND g.disclosure_json=NEW.disclosure_json
    AND r.occurred_at_ms<=NEW.accepted_at_ms AND w.id=NEW.session_id AND w.revoked_at_ms IS NULL
    AND w.fresh_until_ms>NEW.accepted_at_ms AND w.idle_expires_at_ms>NEW.accepted_at_ms
    AND w.hard_expires_at_ms>NEW.accepted_at_ms
)
BEGIN SELECT RAISE(ABORT,'consent_renewal_requires_authority'); END;
CREATE TRIGGER processing_consent_renewals_no_update BEFORE UPDATE ON processing_consent_renewals
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
CREATE TRIGGER processing_consent_renewals_no_delete BEFORE DELETE ON processing_consent_renewals
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
DROP TRIGGER consent_user_revocations_no_delete;
CREATE TRIGGER consent_user_revocations_requires_renewal BEFORE DELETE ON consent_user_revocations
WHEN NOT EXISTS (SELECT 1 FROM processing_consent_renewals n WHERE n.withdrawal_id=OLD.id AND n.user_id=OLD.user_id AND n.grant_record_id=OLD.grant_record_id)
BEGIN SELECT RAISE(ABORT,'consent_renewal_required'); END;
CREATE TABLE processing_consent_renewal_assertion (
  id INTEGER PRIMARY KEY CHECK(id=1),
  accepted INTEGER NOT NULL CHECK(accepted=1)
) STRICT;
