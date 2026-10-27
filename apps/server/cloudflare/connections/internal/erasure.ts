import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "connection_authorizations",
    dataClass: "credentials",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM connection_authorizations r JOIN connection_attempts a ON a.id=r.attempt_id JOIN connections c ON c.id=a.connection_id WHERE c.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM connection_authorizations r JOIN connection_attempts a ON a.id=r.attempt_id JOIN connections c ON c.id=a.connection_id WHERE c.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM connection_authorizations AS r WHERE attempt_id IN(SELECT a.id FROM connection_attempts a JOIN connections c ON c.id=a.connection_id WHERE c.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT value FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
  {
    id: "connection_attempts",
    dataClass: "projections",
    dependencies: ["connection_authorizations"],
    quiescence: { _tag: "Synchronous" },

    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM connection_attempts r WHERE EXISTS(SELECT 1 FROM connections c WHERE c.id=r.connection_id AND c.user_id=?)",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM connection_attempts r WHERE EXISTS(SELECT 1 FROM connections c WHERE c.id=r.connection_id AND c.user_id=?)",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM connection_attempts AS r WHERE EXISTS(SELECT 1 FROM connections c WHERE c.id=r.connection_id AND c.user_id=?) AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },

  {
    id: "connections",
    dataClass: "projections",
    dependencies: ["connection_attempts"],
    quiescence: { _tag: "Synchronous" },

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
        sql: "DELETE FROM connections AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value AS row_ref FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
];
