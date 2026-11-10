import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
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
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM browser_login_pairings r WHERE r.user_id=? OR r.approval_user_id=? OR r.erasure_user_id=?",
      params: [userId, userId, userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM browser_login_pairings r WHERE r.user_id=? OR r.approval_user_id=? OR r.erasure_user_id=?",
      params: [userId, userId, userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM browser_login_pairings AS r WHERE (r.user_id=? OR r.approval_user_id=? OR r.erasure_user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.userId, scope.userId, scope.rowRefsJson],
      },
    ],
  },
];

/** Retired pairings remain attributable for deletion only, never authentication. */
export const erasurePairingsQuery = (userId: string): OwnedStatement => ({
  sql: "SELECT id AS pairingId FROM browser_login_pairings WHERE erasure_user_id=? OR user_id=? OR approval_user_id=?",
  params: [userId, userId, userId],
});
