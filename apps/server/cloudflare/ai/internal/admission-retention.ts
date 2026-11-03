import { Effect } from "effect";
import { OpenAiAdmissionUnavailable } from "../contract";
import { openAiAdmissionWindowMs } from "./admission-policy";

/** Remove bounded expired AI admission evidence; never refund unexpired spend or retry grants. */
export const sweepExpiredOpenAiAdmission = ({
  db,
  now,
}: Readonly<{ db: D1Database; now: number }>): Effect.Effect<void, OpenAiAdmissionUnavailable> =>
  Effect.tryPromise({
    try: () =>
      db.batch([
        db
          .prepare(
            `DELETE FROM resource_admission_events WHERE grant_id IN (
           SELECT id FROM resource_admission_grants
           WHERE id GLOB 'openai-*' AND admitted_at_epoch_ms <= ?
           ORDER BY admitted_at_epoch_ms, id LIMIT 128
         ) AND expires_at_epoch_ms <= ?`
          )
          .bind(now - openAiAdmissionWindowMs, now),
        db
          .prepare(
            `DELETE FROM resource_admission_grants
         WHERE id IN (
           SELECT id FROM resource_admission_grants
           WHERE id GLOB 'openai-*' AND admitted_at_epoch_ms <= ?
           ORDER BY admitted_at_epoch_ms, id LIMIT 128
         )
           AND NOT EXISTS (SELECT 1 FROM resource_admission_events e WHERE e.grant_id = id)`
          )
          .bind(now - openAiAdmissionWindowMs),
      ]),
    catch: () => new OpenAiAdmissionUnavailable(),
  }).pipe(Effect.asVoid);
