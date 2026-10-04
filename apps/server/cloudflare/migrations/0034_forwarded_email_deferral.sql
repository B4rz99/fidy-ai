-- Deferred mail retains bounded bytes but has neither processing admission nor a provider outbox.
CREATE TABLE forwarded_email_deferrals (
  receipt_id TEXT PRIMARY KEY NOT NULL REFERENCES forwarded_email_receipts(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  resume_at_ms INTEGER NOT NULL,
  checked_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX forwarded_email_deferred_user ON forwarded_email_deferrals(user_id,resume_at_ms);
CREATE INDEX forwarded_email_deferred_activation ON forwarded_email_deferrals(checked_at_ms,receipt_id);
CREATE TRIGGER forwarded_email_deferred_capacity BEFORE INSERT ON forwarded_email_deferrals
WHEN NOT EXISTS (SELECT 1 FROM forwarded_email_deferrals WHERE receipt_id = NEW.receipt_id)
 AND (SELECT count(*) FROM forwarded_email_deferrals WHERE user_id = NEW.user_id) >= 50
BEGIN SELECT RAISE(ABORT,'forwarded_email_deferred_capacity'); END;
CREATE TRIGGER forwarded_email_deferred_expiry AFTER UPDATE OF state ON forwarded_email_receipts
WHEN NEW.state = 'expired'
BEGIN DELETE FROM forwarded_email_deferrals WHERE receipt_id = NEW.id AND user_id = NEW.user_id; END;
