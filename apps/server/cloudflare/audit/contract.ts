import { auditRetentionDays, utcDayMilliseconds } from "../../src/shell/audit/contract";

const admissionDays = 93;

export const ordinaryAuditKinds = "'session_call','credential_call','insight_call','publication'";

export const retainedAuditKinds = ordinaryAuditKinds + ",'request_admission'";

export const auditDeadlineExpression = (prefix: "" | "OLD."): string =>
  `${prefix}occurred_at_ms+CASE ${prefix}record_type WHEN 'request_admission' THEN ${admissionDays * utcDayMilliseconds} ELSE ${auditRetentionDays * utcDayMilliseconds + 1} END`;

export const auditRetentionSchema = [
  "CREATE TABLE audit_retention_permits(user_id TEXT PRIMARY KEY REFERENCES users(id),checked_ms INTEGER NOT NULL) STRICT",
  `CREATE INDEX local_audit_retention ON audit_entries((${auditDeadlineExpression("")}),id) WHERE record_type IN (${retainedAuditKinds})`,
  `CREATE TRIGGER audit_entries_delete_authority BEFORE DELETE ON audit_entries WHEN OLD.record_type NOT IN (${retainedAuditKinds}) OR NOT EXISTS(SELECT 1 FROM audit_retention_permits WHERE user_id=OLD.user_id AND checked_ms>=${auditDeadlineExpression("OLD.")} AND NOT EXISTS(SELECT 1 FROM erasure_requests)) BEGIN SELECT RAISE(ABORT,'audit_retention_required'); END`,
];
