import type { ErasureProjection } from "../../erasure-store/contract";

const counterProjection = (
  id: "browser_pairing_email_user_limits" | "email_replacement_limits",
  policyKey: "email.pairing.user.v1" | "email.replacement.user.v1"
): ErasureProjection => {
  const where = "policy_key=? AND window_kind='anchored' AND scope_key=? AND owner_user_id=?";
  const params = (userId: string): ReadonlyArray<string> => [policyKey, userId, userId];
  return {
    id,
    dataClass: "credentials",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: `SELECT CAST(rowid AS TEXT) AS rowRef,'{}' AS body FROM resource_admission_counters WHERE ${where}`,
      params: params(userId),
    }),
    candidates: (userId) => ({
      sql: `SELECT CAST(rowid AS TEXT) AS rowRef FROM resource_admission_counters WHERE ${where}`,
      params: params(userId),
    }),
    remaining: (userId) => ({
      sql: `SELECT 1 FROM resource_admission_counters WHERE ${where}`,
      params: params(userId),
    }),
    remove: (scope) => [
      {
        sql: `DELETE FROM resource_admission_counters WHERE ${where}
        AND CAST(rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)`,
        params: [...params(scope.userId), scope.reference],
      },
    ],
  };
};

export const projections: ReadonlyArray<ErasureProjection> = [
  counterProjection("browser_pairing_email_user_limits", "email.pairing.user.v1"),
  counterProjection("email_replacement_limits", "email.replacement.user.v1"),
  {
    id: "resource_admission_events",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('grant_id',r.\"grant_id\",'policy_key',r.\"policy_key\",'dimension',r.\"dimension\",'scope_key',r.\"scope_key\",'policy_kind',r.\"policy_kind\",'units',r.\"units\",'admitted_at_epoch_ms',r.\"admitted_at_epoch_ms\",'window_start_epoch_ms',r.\"window_start_epoch_ms\",'expires_at_epoch_ms',r.\"expires_at_epoch_ms\",'released_at_epoch_ms',r.\"released_at_epoch_ms\") AS body FROM resource_admission_events r WHERE r.scope_key=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM resource_admission_events r WHERE r.scope_key=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM resource_admission_events r WHERE r.scope_key=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM resource_admission_events AS r WHERE r.scope_key=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
];
