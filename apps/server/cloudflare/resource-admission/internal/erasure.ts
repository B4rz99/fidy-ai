import type { ErasureProjection } from "../../erasure-store/contract";

export const projections: ReadonlyArray<ErasureProjection> = [
  {
    id: "resource_admission_events",
    dataClass: "schedules",
    dependencies: [],
    quiescence: { _tag: "Synchronous" },
    select: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef,json_object('grant_id',r.\"grant_id\",'policy_key',r.\"policy_key\",'dimension',r.\"dimension\",'scope_key',r.\"scope_key\",'policy_kind',r.\"policy_kind\",'units',r.\"units\",'admitted_at_epoch_ms',r.\"admitted_at_epoch_ms\",'window_start_epoch_ms',r.\"window_start_epoch_ms\",'expires_at_epoch_ms',r.\"expires_at_epoch_ms\",'released_at_epoch_ms',r.\"released_at_epoch_ms\") AS body FROM resource_admission_events r WHERE r.scope_key=?",
      params: [userId],
    }),
    candidates: (userId) => ({
      sql: "SELECT CAST(r.rowid AS TEXT) AS rowRef FROM resource_admission_events r WHERE r.scope_key=?",
      params: [userId],
    }),
    remaining: (userId) => ({
      sql: "SELECT 1 FROM resource_admission_events r WHERE r.scope_key=?",
      params: [userId],
    }),
    remove: (scope) => [
      {
        sql: "DELETE FROM resource_admission_events AS r WHERE r.scope_key=? AND CAST(r.rowid AS TEXT) IN(SELECT row_ref FROM erasure_chunk WHERE request_id=?)",
        params: [scope.userId, scope.reference],
      },
    ],
  },
];
