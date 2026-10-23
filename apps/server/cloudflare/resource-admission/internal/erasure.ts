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
        AND CAST(rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))`,
        params: [...params(scope.userId), scope.rowRefsJson],
      },
    ],
  };
};

const reviewOwnerSql =
  "r.policy_key='pat.review.session.v1' AND r.dimension='source' AND r.scope_key IN(SELECT id FROM web_sessions WHERE user_id=?) AND r.owner_user_id=?";
const reviewOwnerParams = (userId: string): ReadonlyArray<string> => [userId, userId];

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "hosted_compaction_attempts",
    dataClass: "conversation",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM resource_admission_counters r WHERE r.policy_key='hosted.compaction.user.v1' AND r.window_kind='calendar' AND r.scope_key=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM resource_admission_counters r WHERE r.policy_key='hosted.compaction.user.v1' AND r.window_kind='calendar' AND r.scope_key=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM resource_admission_counters AS r WHERE r.policy_key='hosted.compaction.user.v1' AND r.window_kind='calendar' AND r.scope_key=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },

  counterProjection("browser_pairing_email_user_limits", "email.pairing.user.v1"),
  counterProjection("email_replacement_limits", "email.replacement.user.v1"),
  {
    id: "pat_review_attempts",
    dataClass: "credentials",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: `SELECT CAST(r.rowid AS TEXT) AS rowRef FROM resource_admission_events r WHERE ${reviewOwnerSql}`,
      params: reviewOwnerParams(userId),
    }),
    remaining: (userId) => ({
      sql: `SELECT 1 FROM resource_admission_events r WHERE ${reviewOwnerSql}`,
      params: reviewOwnerParams(userId),
    }),
    remove: (scope) => [
      {
        sql: `DELETE FROM resource_admission_events AS r WHERE ${reviewOwnerSql} AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))`,
        params: [...reviewOwnerParams(scope.userId), scope.rowRefsJson],
      },
    ],
  },
  {
    id: "resource_admission_events",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM resource_admission_events r WHERE r.policy_key<>'pat.review.session.v1' AND r.scope_key=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM resource_admission_events r WHERE r.policy_key<>'pat.review.session.v1' AND r.scope_key=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM resource_admission_events AS r WHERE r.policy_key<>'pat.review.session.v1' AND r.scope_key=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
];
