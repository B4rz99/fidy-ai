CREATE TABLE support_recovery_admissions (
  id TEXT PRIMARY KEY NOT NULL,
  operator_issuer TEXT NOT NULL,
  operator_subject TEXT NOT NULL,
  admitted_at_ms INTEGER NOT NULL
);
CREATE INDEX support_recovery_admissions_time ON support_recovery_admissions(admitted_at_ms);
CREATE INDEX support_recovery_admissions_operator ON support_recovery_admissions(operator_issuer, operator_subject, admitted_at_ms);
