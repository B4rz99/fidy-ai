import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "budget_crossing_publications",
    dataClass: "projections",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'delivery_group_id',r.\"delivery_group_id\",'detected_at_ms',r.\"detected_at_ms\",'materialized_at_ms',r.\"materialized_at_ms\") AS body FROM budget_publications r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM budget_publications r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM budget_publications r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM budget_publications AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "budget_group_currencies",
    dataClass: "projections",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'group_name',r.\"group_name\",'month',r.\"month\",'currency',r.\"currency\") AS body FROM (SELECT rowid,user_id,group_name,month,currency FROM budget_month_plan_records WHERE kind='currency') r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,user_id,group_name,month,currency FROM budget_month_plan_records WHERE kind='currency') r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,user_id,group_name,month,currency FROM budget_month_plan_records WHERE kind='currency') r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM budget_month_plan_records AS r WHERE r.kind='currency' AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "budget_month_caps",
    dataClass: "projections",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'budget_id',r.\"budget_id\",'month',r.\"month\",'cap',r.\"cap\") AS body FROM (SELECT rowid,user_id,budget_id,month,cap FROM budget_month_plan_records WHERE kind='cap') r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,user_id,budget_id,month,cap FROM budget_month_plan_records WHERE kind='cap') r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,user_id,budget_id,month,cap FROM budget_month_plan_records WHERE kind='cap') r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM budget_month_plan_records AS r WHERE r.kind='cap' AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "budget_month_latches",
    dataClass: "projections",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'budget_id',r.\"budget_id\",'from_utc_ms',r.\"from_utc_ms\",'time_zone',r.\"time_zone\",'highest_reached',r.\"highest_reached\") AS body FROM budget_month_latches r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM budget_month_latches r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM budget_month_latches r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM budget_month_latches AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "budget_plan_months",
    dataClass: "projections",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'month',r.\"month\") AS body FROM (SELECT rowid,user_id,month FROM budget_month_plan_records WHERE kind='plan') r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,user_id,month FROM budget_month_plan_records WHERE kind='plan') r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,user_id,month FROM budget_month_plan_records WHERE kind='plan') r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM budget_month_plan_records AS r WHERE r.kind='plan' AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "budget_reconciliation_work",
    dataClass: "projections",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'occurred_at_ms',r.\"occurred_at_ms\",'version',r.\"version\") AS body FROM budget_evaluation_work r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM budget_evaluation_work r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM budget_evaluation_work r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM budget_evaluation_work AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "budget_threshold_alerts",
    dataClass: "projections",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'budget_id',r.\"budget_id\",'from_utc_ms',r.\"from_utc_ms\",'time_zone',r.\"time_zone\",'threshold',r.\"threshold\",'state',r.\"state\",'crossing_json',r.\"crossing_json\",'delivery_group_id',r.\"delivery_group_id\",'consent_grant_id',r.\"consent_grant_id\") AS body FROM budget_threshold_alerts r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM budget_threshold_alerts r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM budget_threshold_alerts r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM budget_threshold_alerts AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "budget_user_state",
    dataClass: "projections",
    dependencies: ["budgets"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'revision',r.\"revision\",'first_budget_id',r.first_budget_id,'first_created_at_ms',r.first_created_at_ms,'offer_requested_at_ms',r.offer_requested_at_ms,'last_evaluated_at_ms',r.last_evaluated_at_ms) AS body FROM budget_user_state r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM budget_user_state r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM budget_user_state r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM budget_user_state AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "budgets",
    dataClass: "projections",
    dependencies: ["budget_month_caps", "budget_month_latches", "budget_threshold_alerts"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'category_id',r.\"category_id\",'currency',r.\"currency\",'cap',r.\"cap\",'created_at_ms',r.\"created_at_ms\",'updated_at_ms',r.\"updated_at_ms\",'group_name',r.\"group_name\",'starts_month',r.\"starts_month\") AS body FROM budgets r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM budgets r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({ sql: "SELECT 1 FROM budgets r WHERE r.user_id=?", params: [userId] }),
    remove: (scope) => [
      {
        sql: "DELETE FROM budgets AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
];
