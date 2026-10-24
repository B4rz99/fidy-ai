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
      "whatsapp_signup_invitations",
    ],
    quiescence: { _tag: "Synchronous" },

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
        sql: "DELETE FROM browser_login_pairings AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
];
