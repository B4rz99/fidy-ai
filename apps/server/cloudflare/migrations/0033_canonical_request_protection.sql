-- Security admission, deliberately independent of commercial calendar-month counters.
CREATE TABLE canonical_request_buckets (
  subject TEXT PRIMARY KEY NOT NULL,
  virtual_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX canonical_request_bucket_expiry ON canonical_request_buckets(virtual_at_ms);
CREATE TABLE canonical_request_leases (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  expires_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX canonical_request_lease_expiry ON canonical_request_leases(user_id,expires_at_ms);
CREATE INDEX canonical_request_global_lease_expiry ON canonical_request_leases(expires_at_ms);
CREATE TRIGGER canonical_request_concurrency BEFORE INSERT ON canonical_request_leases
WHEN (SELECT count(*) FROM canonical_request_leases WHERE user_id = NEW.user_id AND expires_at_ms > NEW.expires_at_ms - 90000) >= 2
BEGIN SELECT RAISE(ABORT,'canonical_request_concurrency'); END;
CREATE TABLE canonical_request_assertions (
  id TEXT PRIMARY KEY NOT NULL,
  accepted INTEGER NOT NULL CONSTRAINT canonical_request_rate CHECK (accepted = 1)
) STRICT;
-- Attribution for the original admitted envelope, independent of later domain outcome/Audit.
CREATE TABLE canonical_request_acceptances (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  pat_id TEXT NOT NULL REFERENCES pats(id),
  operation TEXT NOT NULL,
  accepted_at_ms INTEGER NOT NULL
) STRICT;
CREATE INDEX canonical_request_acceptance_expiry ON canonical_request_acceptances(accepted_at_ms);
CREATE TRIGGER canonical_request_acceptance_no_update BEFORE UPDATE ON canonical_request_acceptances
BEGIN SELECT RAISE(ABORT,'canonical_admission_append_only'); END;
