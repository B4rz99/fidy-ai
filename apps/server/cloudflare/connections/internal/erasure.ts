import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "connection_attempts",
    dataClass: "projections",
    dependencies: ["connection_authorization_executions"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'connection_id',r.\"connection_id\",'institution_id',r.\"institution_id\",'public_reference',r.\"public_reference\",'status',r.\"status\",'created_at_ms',r.\"created_at_ms\",'expires_at_ms',r.\"expires_at_ms\",'consumed_at_ms',r.\"consumed_at_ms\") AS body FROM connection_attempts r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM connection_attempts r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM connection_attempts r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM connection_attempts AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "connection_authorization_executions",
    dataClass: "projections",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('attempt_id',r.\"attempt_id\",'session_id',r.\"session_id\",'prepared_at_ms',r.\"prepared_at_ms\") AS body FROM connection_authorization_executions r WHERE EXISTS(SELECT 1 FROM web_sessions p WHERE p.id=r.session_id AND p.user_id=?)",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM connection_authorization_executions r WHERE EXISTS(SELECT 1 FROM web_sessions p WHERE p.id=r.session_id AND p.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM connection_authorization_executions r WHERE EXISTS(SELECT 1 FROM web_sessions p WHERE p.id=r.session_id AND p.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM connection_authorization_executions AS r WHERE EXISTS(SELECT 1 FROM web_sessions p WHERE p.id=r.session_id AND p.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "connections",
    dataClass: "projections",
    dependencies: ["connection_attempts"],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'institution_id',r.\"institution_id\",'state',r.\"state\",'created_at_ms',r.\"created_at_ms\",'updated_at_ms',r.\"updated_at_ms\") AS body FROM connections r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM connections r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM connections r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM connections AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
];
