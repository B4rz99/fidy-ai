import { DateTime, Effect, Schema } from "effect";
import { UserId } from "../../../src/core/identity/contract";
import { InsightUnavailable } from "../contract";

const maximumGenerationUsers = 16;
/** Bounded identities only; discovery does not read content or grant execution authority. */
export const discoverProactivityUsers = (
  input: Readonly<{ db: D1Database; now: DateTime.Utc }>
): Effect.Effect<ReadonlyArray<UserId>, InsightUnavailable> =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          "SELECT s.user_id FROM reminder_schedules AS s JOIN reminder_governors AS g ON g.user_id=s.user_id WHERE s.enabled=1 AND s.next_scheduled_at<=? AND json_extract(g.standing_json,'$._tag')<>'Paused' ORDER BY s.last_evaluated_at_ms,s.next_scheduled_at,s.id LIMIT 16"
        )
        .bind(DateTime.formatIso(input.now))
        .all()
    );
    return (yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ user_id: UserId })).check(
        Schema.isMaxLength(maximumGenerationUsers)
      )
    )(rows.results)).map((row) => row.user_id);
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
/** Rotate attempted work even when processing authority or coordination is unavailable. */
export const noteProactivityEvaluation = (
  input: Readonly<{ db: D1Database; userId: UserId; now: DateTime.Utc }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.tryPromise(() =>
    input.db
      .prepare("UPDATE reminder_schedules SET last_evaluated_at_ms=? WHERE user_id=?")
      .bind(input.now.epochMilliseconds, input.userId)
      .run()
  ).pipe(
    Effect.asVoid,
    Effect.mapError(() => new InsightUnavailable())
  );
