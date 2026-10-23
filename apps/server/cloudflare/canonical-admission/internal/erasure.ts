import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "canonical_request_buckets",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

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
        sql: "DELETE FROM canonical_request_buckets AS r WHERE r.subject='user:'||? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
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
        sql: "DELETE FROM canonical_request_leases AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "canonical_request_replays",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },

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
        sql: "DELETE FROM canonical_request_replays AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
];
