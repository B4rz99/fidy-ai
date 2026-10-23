import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "memories",
    dataClass: "memory",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('id',r.\"id\",'user_id',r.\"user_id\",'text',r.\"text\",'created_at',strftime('%Y-%m-%dT%H:%M:%fZ',r.created_at_ms/1000.0,'unixepoch'),'updated_at',strftime('%Y-%m-%dT%H:%M:%fZ',r.updated_at_ms/1000.0,'unixepoch')) AS body FROM memories r WHERE r.user_id=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM memories r WHERE r.user_id=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM memories r WHERE r.user_id=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM memories AS r WHERE r.user_id=? AND CAST(r.rowid AS TEXT) IN(SELECT value FROM json_each(?))",
        params: [scope.userId, scope.rowRefsJson],
      },
    ],
  },
];
