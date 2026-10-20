import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "browser_login_pairings",
    dataClass: "credentials",
    dependencies: [
      "browser_pairing_email_proofs",
      "provider_authentication_attempts",
      "support_recovery_cases",
      "web_sessions",
      "whatsapp_provider_handoffs",
    ],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,'{}' AS body FROM browser_login_pairings r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM browser_login_pairings r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM browser_login_pairings r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM browser_login_pairings AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
];
