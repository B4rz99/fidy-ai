import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "recurring_confirmations",
    dataClass: "projections",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('sequence',r.confirmation_sequence,'digest_excluded',r.\"digest_excluded\",'user_id',r.\"user_id\",'id',r.\"confirmation_id\",'series_id',r.\"id\",'confirmed_at_ms',r.\"confirmed_at_ms\",'context_json',r.\"confirmation_context_json\",'confirmation_json',r.\"confirmation_json\") AS body FROM recurring_series r WHERE r.confirmation_id IS NOT NULL AND r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM recurring_series r WHERE r.confirmation_id IS NOT NULL AND r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM recurring_series r WHERE r.confirmation_id IS NOT NULL AND r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "UPDATE recurring_series AS r SET confirmation_id=NULL,confirmed_at_ms=NULL,confirmation_context_json=NULL,confirmation_json=NULL,digest_excluded=NULL,confirmation_sequence=NULL WHERE r.confirmation_id IS NOT NULL AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "recurring_dispatch",
    dataClass: "projections",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'last_user',r.\"last_user\",'next_discovery_at_ms',r.\"next_discovery_at_ms\") AS body FROM recurring_dispatch r WHERE r.last_user=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM recurring_dispatch r WHERE r.last_user=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM recurring_dispatch r WHERE r.last_user=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM recurring_dispatch AS r WHERE r.last_user=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "recurring_facts",
    dataClass: "projections",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'id',r.\"id\",'group_key',r.\"group_key\",'occurred_at_ms',r.\"occurred_at_ms\",'fact_json',r.\"fact_json\") AS body FROM (SELECT rowid,user_id,id,group_key,occurred_at_ms,fact_json FROM recurring_evaluation_records WHERE kind='fact') r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,user_id,id,group_key,occurred_at_ms,fact_json FROM recurring_evaluation_records WHERE kind='fact') r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,user_id,id,group_key,occurred_at_ms,fact_json FROM recurring_evaluation_records WHERE kind='fact') r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM recurring_evaluation_records AS r WHERE r.kind='fact' AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "recurring_progress",
    dataClass: "projections",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'revision',r.\"revision\",'phase',r.\"phase\",'cursor_at_ms',r.\"cursor_at_ms\",'cursor_id',r.\"cursor_id\",'group_key',r.\"group_key\",'evaluated_at_ms',r.\"evaluated_at_ms\",'evaluated_revision',r.\"evaluated_revision\",'first_captured_at_ms',r.\"first_captured_at_ms\",'time_zone',r.\"time_zone\") AS body FROM (SELECT rowid,user_id,revision,phase,cursor_at_ms,cursor_id,group_key,evaluated_at_ms,evaluated_revision,first_captured_at_ms,time_zone FROM recurring_evaluation_records WHERE kind='progress') r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,user_id,revision,phase,cursor_at_ms,cursor_id,group_key,evaluated_at_ms,evaluated_revision,first_captured_at_ms,time_zone FROM recurring_evaluation_records WHERE kind='progress') r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,user_id,revision,phase,cursor_at_ms,cursor_id,group_key,evaluated_at_ms,evaluated_revision,first_captured_at_ms,time_zone FROM recurring_evaluation_records WHERE kind='progress') r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM recurring_evaluation_records AS r WHERE r.kind='progress' AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "recurring_proposals",
    dataClass: "projections",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'proposal_key',r.\"proposal_key\",'proposal_json',r.\"proposal_json\") AS body FROM (SELECT rowid,user_id,id AS proposal_key,proposal_json FROM recurring_evaluation_records WHERE kind='proposal') r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM (SELECT rowid,user_id,id AS proposal_key,proposal_json FROM recurring_evaluation_records WHERE kind='proposal') r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM (SELECT rowid,user_id,id AS proposal_key,proposal_json FROM recurring_evaluation_records WHERE kind='proposal') r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM recurring_evaluation_records AS r WHERE r.kind='proposal' AND r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "recurring_series",
    dataClass: "projections",
    dependencies: ["recurring_confirmations"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'id',r.\"id\",'currency',r.\"currency\",'counterparty_key',r.\"counterparty_key\",'series_json',r.\"series_json\",'evidence_json',r.\"evidence_json\",'reference_json',r.\"reference_json\",'valid',r.\"valid\") AS body FROM recurring_series r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM recurring_series r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM recurring_series r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM recurring_series AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
];
