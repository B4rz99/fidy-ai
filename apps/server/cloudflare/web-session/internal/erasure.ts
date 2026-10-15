import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "web_sessions",
    dataClass: "credentials",
    dependencies: [
      "budget_audit",
      "canonical_security_mutations",
      "canonical_user_reads",
      "category_audit",
      "connection_authorization_executions",
      "consent_user_revocations",
      "email_replacement_audit",
      "email_replacements",
      "insight_audit",
      "memory_audit",
      "oauth_grant_consents",
      "oauth_user_revocation_consents",
      "pat_audit",
      "pat_grant_consents",
      "pat_review_attempts",
      "pat_revocation_consents",
      "transaction_audit",
    ],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,'{}' AS body FROM web_sessions r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM web_sessions r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM web_sessions r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM web_sessions AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
];
