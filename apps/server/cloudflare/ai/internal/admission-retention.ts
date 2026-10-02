import { Effect } from "effect";
import { WorkersAiAdmissionUnavailable } from "../contract";
import { workersAiAdmissionWindowMs } from "./admission-policy";

/** Remove bounded expired AI admission evidence; never refund unexpired spend or retry grants. */
export const sweepExpiredWorkersAiAdmission = ({
  db,
  now,
}: Readonly<{ db: D1Database; now: number }>): Effect.Effect<void, WorkersAiAdmissionUnavailable> =>
  Effect.tryPromise({
    try: () =>
      db.batch([
        db
          .prepare(
            `DELETE FROM resource_admission_events WHERE grant_id IN (
           SELECT id FROM resource_admission_grants
           WHERE id LIKE 'workers-ai-%' AND admitted_at_epoch_ms <= ?
           ORDER BY admitted_at_epoch_ms LIMIT 128
         ) AND expires_at_epoch_ms <= ?`
          )
          .bind(now - workersAiAdmissionWindowMs, now),
        db
          .prepare(
            `DELETE FROM resource_admission_grants
         WHERE id LIKE 'workers-ai-%' AND admitted_at_epoch_ms <= ?
           AND NOT EXISTS (SELECT 1 FROM resource_admission_events e WHERE e.grant_id = id)`
          )
          .bind(now - workersAiAdmissionWindowMs),
      ]),
    catch: () => new WorkersAiAdmissionUnavailable(),
  }).pipe(Effect.asVoid);
