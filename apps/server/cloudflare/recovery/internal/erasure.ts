import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "backup_recovery_credentials",
    dataClass: "credentials",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,'{}' AS body FROM (SELECT rowid,id AS user_id,recovery_code_digest AS code_digest,recovery_created_at_ms AS created_at_ms,recovery_consumed_at_ms AS consumed_at_ms,recovery_revision AS revision FROM users WHERE recovery_code_digest IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,id AS user_id,recovery_code_digest AS code_digest,recovery_created_at_ms AS created_at_ms,recovery_consumed_at_ms AS consumed_at_ms,recovery_revision AS revision FROM users WHERE recovery_code_digest IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,id AS user_id,recovery_code_digest AS code_digest,recovery_created_at_ms AS created_at_ms,recovery_consumed_at_ms AS consumed_at_ms,recovery_revision AS revision FROM users WHERE recovery_code_digest IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE users AS r SET recovery_code_digest=NULL,recovery_created_at_ms=NULL,recovery_consumed_at_ms=NULL,recovery_revision=NULL WHERE r.id=? AND r.recovery_code_digest IS NOT NULL AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "support_recovery_cases",
    dataClass: "credentials",
    dependencies: ["support_recovery_events"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,'{}' AS body FROM support_recovery_cases r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM support_recovery_cases r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM support_recovery_cases r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM support_recovery_cases AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "support_recovery_events",
    dataClass: "credentials",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,'{}' AS body FROM (SELECT sequence AS rowid,id,recovery_case_id AS case_id,user_id,operator_issuer,operator_subject,recovery_action AS action,occurred_at_ms AS at_ms FROM audit_entries WHERE record_type='support_recovery') r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT sequence AS rowid,id,recovery_case_id AS case_id,user_id,operator_issuer,operator_subject,recovery_action AS action,occurred_at_ms AS at_ms FROM audit_entries WHERE record_type='support_recovery') r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT sequence AS rowid,id,recovery_case_id AS case_id,user_id,operator_issuer,operator_subject,recovery_action AS action,occurred_at_ms AS at_ms FROM audit_entries WHERE record_type='support_recovery') r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM audit_entries AS r WHERE record_type='support_recovery' AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
];
