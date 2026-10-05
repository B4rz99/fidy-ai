CREATE TABLE proactivity_consent_offers (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('budget-threshold','manual-entry-reminder')),
  portfolio_id TEXT NOT NULL,
  bsuid TEXT NOT NULL,
  disclosure_json TEXT NOT NULL CHECK(json_valid(disclosure_json)),
  created_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL CHECK(expires_at_ms>created_at_ms),
  disclosure_message_id TEXT,
  decision_message_id TEXT UNIQUE,
  decision TEXT CHECK(decision IN ('accept','decline','revoke')),
  UNIQUE(user_id,kind,id),
  CHECK((decision IS NULL)=(decision_message_id IS NULL))
) STRICT;
CREATE INDEX proactivity_consent_offers_user ON proactivity_consent_offers(user_id,kind,created_at_ms);
CREATE TRIGGER proactivity_offer_immutable BEFORE UPDATE ON proactivity_consent_offers
WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.kind IS NOT OLD.kind
 OR NEW.portfolio_id IS NOT OLD.portfolio_id OR NEW.bsuid IS NOT OLD.bsuid
 OR NEW.disclosure_json IS NOT OLD.disclosure_json OR NEW.created_at_ms IS NOT OLD.created_at_ms
 OR NEW.expires_at_ms IS NOT OLD.expires_at_ms
 OR (OLD.disclosure_message_id IS NOT NULL AND NEW.disclosure_message_id IS NOT OLD.disclosure_message_id)
 OR (OLD.decision_message_id IS NOT NULL AND (NEW.decision_message_id IS NOT OLD.decision_message_id OR NEW.decision IS NOT OLD.decision))
BEGIN SELECT RAISE(ABORT,'consent_offer_immutable'); END;
CREATE TABLE proactivity_consent_records (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('budget-threshold','manual-entry-reminder')),
  grant_id TEXT UNIQUE REFERENCES proactivity_consent_records(id),
  offer_id TEXT NOT NULL REFERENCES proactivity_consent_offers(id),
  decision_message_id TEXT NOT NULL UNIQUE,
  record_json TEXT NOT NULL CHECK(json_valid(record_json)),
  occurred_at_ms INTEGER NOT NULL,
  UNIQUE(user_id,kind,id)
) STRICT;
CREATE INDEX proactivity_consent_records_user ON proactivity_consent_records(user_id,kind,grant_id);
CREATE TRIGGER proactivity_consent_records_no_update BEFORE UPDATE ON proactivity_consent_records
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
CREATE TRIGGER proactivity_consent_records_no_delete BEFORE DELETE ON proactivity_consent_records
BEGIN SELECT RAISE(ABORT,'consent_append_only'); END;
CREATE TABLE proactivity_consent_assertion (
  id INTEGER PRIMARY KEY NOT NULL CHECK(id=1),
  accepted INTEGER NOT NULL CHECK(accepted=1)
) STRICT;
