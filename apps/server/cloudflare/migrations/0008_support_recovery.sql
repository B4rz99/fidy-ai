ALTER TABLE backup_recovery_credentials ADD COLUMN consumed_at_ms INTEGER;
ALTER TABLE backup_recovery_credentials ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

-- A case is attributable only after an Access-authenticated operator presents a pre-issued
-- BackupRecoveryCode with a current digest. D1 owns the single-use transition and audit record.
CREATE TABLE support_recovery_cases (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  pairing_id TEXT NOT NULL UNIQUE REFERENCES browser_login_pairings(id),
  operator_issuer TEXT NOT NULL,
  operator_subject TEXT NOT NULL,
  credential_revision INTEGER NOT NULL CHECK (credential_revision > 0),
  opened_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('approved', 'rejected')),
  closed_at_ms INTEGER NOT NULL,
  CHECK (expires_at_ms > opened_at_ms)
);
CREATE INDEX support_recovery_cases_user ON support_recovery_cases(user_id, opened_at_ms);

CREATE TABLE support_recovery_events (
  id TEXT PRIMARY KEY NOT NULL,
  case_id TEXT NOT NULL REFERENCES support_recovery_cases(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  operator_issuer TEXT NOT NULL,
  operator_subject TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('opened', 'approved', 'rejected')),
  at_ms INTEGER NOT NULL
);
CREATE INDEX support_recovery_events_case ON support_recovery_events(case_id, at_ms);

-- Per verified operator, not per public pairing: an attacker cannot lock out other Users.
CREATE TABLE support_recovery_operator_limits (
  operator_issuer TEXT NOT NULL,
  operator_subject TEXT NOT NULL,
  window_started_at_ms INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts >= 1 AND attempts <= 10),
  PRIMARY KEY (operator_issuer, operator_subject)
);
