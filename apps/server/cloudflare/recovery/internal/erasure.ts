import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "backup_recovery_credentials",
    dataClass: "credentials",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM backup_recovery_credentials r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM backup_recovery_credentials r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM backup_recovery_credentials AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "support_recovery_cases",
    dataClass: "credentials",
    dependencies: ["support_recovery_events"],
    quiescence: { _tag: "Synchronous" },

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
        sql: "DELETE FROM support_recovery_cases AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "support_recovery_events",
    dataClass: "credentials",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT user_id,opened_event_row_ref AS rowid FROM support_recovery_cases WHERE opened_event_id IS NOT NULL UNION ALL SELECT user_id,decision_event_row_ref AS rowid FROM support_recovery_cases WHERE decision_event_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT user_id,opened_event_row_ref AS rowid FROM support_recovery_cases WHERE opened_event_id IS NOT NULL UNION ALL SELECT user_id,decision_event_row_ref AS rowid FROM support_recovery_cases WHERE decision_event_id IS NOT NULL) r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "WITH selected AS (SELECT value AS row_ref FROM json_each(?)) UPDATE support_recovery_cases SET opened_event_id=CASE WHEN opened_event_row_ref IN(SELECT row_ref FROM selected) THEN NULL ELSE opened_event_id END,opened_event_row_ref=CASE WHEN opened_event_row_ref IN(SELECT row_ref FROM selected) THEN NULL ELSE opened_event_row_ref END,decision_event_id=CASE WHEN decision_event_row_ref IN(SELECT row_ref FROM selected) THEN NULL ELSE decision_event_id END,decision_event_row_ref=CASE WHEN decision_event_row_ref IN(SELECT row_ref FROM selected) THEN NULL ELSE decision_event_row_ref END WHERE user_id=? AND (opened_event_row_ref IN(SELECT row_ref FROM selected) OR decision_event_row_ref IN(SELECT row_ref FROM selected))",
        params: [scope.rowRefsJson, scope.userId],
      },
    ],
  },
];
