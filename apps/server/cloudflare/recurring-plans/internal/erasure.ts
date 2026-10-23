import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "recurring_plan_documents",
    dataClass: "schedules",
    dependencies: ["recurring_plans"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'document_json',r.\"document_json\",'revision',r.\"revision\") AS body FROM user_documents r WHERE r.kind='recurring-plan' AND r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM user_documents r WHERE r.kind='recurring-plan' AND r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM user_documents r WHERE r.kind='recurring-plan' AND r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM user_documents AS r WHERE r.kind='recurring-plan' AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "recurring_plans",
    dataClass: "schedules",
    dependencies: [
      "recurring_plan_revisions",
      "recurring_plan_exceptions",
      "recurring_plan_fulfillments",
    ],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: `SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r."user_id",'id',r."id",'position',r."position",'pauses_json',r."pauses_json",'stopped_on',r."stopped_on") AS body FROM recurring_plans r WHERE r.user_id=?`,
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM recurring_plans r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM recurring_plans r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM recurring_plans AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "recurring_plan_revisions",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: `SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r."user_id",'plan_id',r."plan_id",'position',r."position",'from_date',r."from_date",'plan_json',r."plan_json") AS body FROM recurring_plan_revisions r WHERE r.user_id=?`,
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM recurring_plan_revisions r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM recurring_plan_revisions r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM recurring_plan_revisions AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "recurring_plan_exceptions",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: `SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r."user_id",'plan_id',r."plan_id",'position',r."position",'local_date',r."local_date",'skipped',r."skipped",'replacement_json',r."replacement_json") AS body FROM recurring_plan_exceptions r WHERE r.user_id=?`,
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM recurring_plan_exceptions r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM recurring_plan_exceptions r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM recurring_plan_exceptions AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "recurring_plan_fulfillments",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: `SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r."user_id",'id',r."id",'plan_id',r."plan_id",'position',r."position",'local_date',r."local_date",'actual_date',r."actual_date",'amount',r."amount",'currency',r."currency",'settled',r."settled",'automatic',r."automatic",'transaction_id',r."transaction_id") AS body FROM recurring_plan_fulfillments r WHERE r.user_id=?`,
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM recurring_plan_fulfillments r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM recurring_plan_fulfillments r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM recurring_plan_fulfillments AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
];
