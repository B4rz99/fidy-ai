import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "canonical_request_acceptances",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'pat_id',r.\"pat_id\",'operation',r.\"operation\",'accepted_at_ms',r.\"accepted_at_ms\") AS body FROM canonical_request_acceptances r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM canonical_request_acceptances r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM canonical_request_acceptances r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM canonical_request_acceptances AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "canonical_request_buckets",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('subject',r.\"subject\",'virtual_at_ms',r.\"virtual_at_ms\") AS body FROM canonical_request_buckets r WHERE r.subject='user:'||?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM canonical_request_buckets r WHERE r.subject='user:'||?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM canonical_request_buckets r WHERE r.subject='user:'||?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM canonical_request_buckets AS r WHERE r.subject='user:'||? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "canonical_request_leases",
    dataClass: "schedules",
    dependencies: [],
    quiescence: {
      _tag: "Durable",
      select: ({ current, userId }) => ({
        sql: "SELECT 1 FROM canonical_request_leases WHERE user_id=? AND expires_at_ms>?",
        params: [userId, current],
      }),
    },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'expires_at_ms',r.\"expires_at_ms\") AS body FROM canonical_request_leases r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM canonical_request_leases r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM canonical_request_leases r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM canonical_request_leases AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "canonical_request_replays",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('user_id',r.\"user_id\",'operation',r.\"operation\",'identity',r.\"identity\",'accepted_at_ms',r.\"accepted_at_ms\",'expires_at_ms',r.\"expires_at_ms\",'state',r.\"state\",'status',r.\"status\",'body',r.\"body\",'content_type',r.\"content_type\") AS body FROM canonical_request_replays r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM canonical_request_replays r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM canonical_request_replays r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM canonical_request_replays AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "canonical_security_mutations",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'session_id',r.\"session_id\",'operation',r.\"operation\",'occurred_at_ms',r.\"occurred_at_ms\") AS body FROM canonical_security_mutations r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM canonical_security_mutations r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM canonical_security_mutations r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM canonical_security_mutations AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
  {
    id: "canonical_user_reads",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'session_id',r.\"session_id\",'occurred_at_ms',r.\"occurred_at_ms\") AS body FROM canonical_user_reads r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM canonical_user_reads r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM canonical_user_reads r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM canonical_user_reads AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
];
