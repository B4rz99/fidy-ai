import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "web_sessions",
    dataClass: "credentials",
    dependencies: [
      "session_audit",
      "processing_consent_withdrawal_records",
      "processing_consent_renewals",
      "canonical_security_mutations",
      "canonical_user_reads",
      "connection_attempts",
      "email_replacements",
      "insight_audit",
      "oauth_grant_consents",
      "oauth_operation_intents",
      "oauth_user_revocation_consents",
      "pat_audit",
      "pat_grant_consents",
      "pat_review_attempts",
      "pat_revocation_consents",
    ],
    quiescence: { _tag: "Synchronous" },

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
        sql: "DELETE FROM web_sessions AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
];
