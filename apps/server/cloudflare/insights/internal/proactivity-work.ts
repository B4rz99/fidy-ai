import { recurringDigestSourceIdentities } from "../../recurring/operations";
import { DateTime, Effect, Schema } from "effect";
import {
  discoverBudgetCrossingUsers,
  noteBudgetCrossingEvaluation,
} from "../../budgets/operations";
import { UserId } from "../../../src/core/identity/contract";
import { InsightUnavailable } from "../contract";

import { offerWindowOpen, recoverableOfferRequests } from "./proactivity-offers";

const maximumGenerationUsers = 16;
/** Bounded identities only; discovery does not read content or grant execution authority. */
export const discoverProactivityUsers = (
  input: Readonly<{ db: D1Database; now: DateTime.Utc }>
): Effect.Effect<ReadonlyArray<UserId>, InsightUnavailable> =>
  Effect.gen(function* () {
    const rows = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          "SELECT s.user_id FROM reminder_schedules AS s JOIN reminder_governors AS g ON g.user_id=s.user_id WHERE s.enabled=1 AND (s.next_scheduled_at<=? OR (json_extract(g.standing_json,'$._tag')='QuestionPending' AND (g.question_id IS NULL OR EXISTS (SELECT 1 FROM proactivity_outbox AS o WHERE o.user_id=g.user_id AND o.delivery_id=g.question_id AND o.state='expired')))) AND json_extract(g.standing_json,'$._tag')<>'Paused' ORDER BY s.last_evaluated_at_ms,s.next_scheduled_at,s.id LIMIT 16"
        )
        .bind(DateTime.formatIso(input.now))
        .all()
    );
    const reminders = (yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ user_id: UserId })).check(
        Schema.isMaxLength(maximumGenerationUsers)
      )
    )(rows.results)).map((row) => row.user_id);
    const budgets = yield* discoverBudgetCrossingUsers(input);
    const pending = recoverableOfferRequests(input.now);
    const offersRaw = offerWindowOpen(input.now)
      ? yield* Effect.tryPromise(() =>
          input.db
            .prepare(
              `SELECT user_id FROM (${pending.sql}) GROUP BY user_id ORDER BY min(last_evaluated_at_ms),min(created_at_ms) LIMIT ?`
            )
            .bind(...pending.params, maximumGenerationUsers)
            .all()
        )
      : { results: [] };
    const offers = (yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ user_id: UserId })).check(
        Schema.isMaxLength(maximumGenerationUsers)
      )
    )(offersRaw.results)).map((row) => row.user_id);
    const source = recurringDigestSourceIdentities();
    const recurringRaw = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          `SELECT i.user_id FROM recurring_digest_instructions AS i JOIN (${source.sql}) AS s ON s.user_id=i.user_id WHERE i.enabled=1 AND (i.last_source_identity IS NULL OR i.last_source_identity<>s.source_identity OR i.next_closed_at_ms<=?) ORDER BY i.last_evaluated_at_ms,i.user_id LIMIT ?`
        )
        .bind(...source.params, input.now.epochMilliseconds, maximumGenerationUsers)
        .all()
    );
    const recurring = (yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ user_id: UserId }))
    )(recurringRaw.results)).map((row) => row.user_id);
    const balanced = Array.from({ length: maximumGenerationUsers }, (_, index) => [
      ...offers.slice(index, index + 1),
      ...budgets.slice(index, index + 1),
      ...reminders.slice(index, index + 1),
      ...recurring.slice(index, index + 1),
    ]).flat();
    return [...new Set(balanced)].slice(0, maximumGenerationUsers);
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
/** Rotate attempted work even when processing authority or coordination is unavailable. */
export const noteProactivityEvaluation = (
  input: Readonly<{ db: D1Database; userId: UserId; now: DateTime.Utc }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.gen(function* () {
    yield* Effect.tryPromise(() =>
      input.db
        .prepare("UPDATE recurring_digest_instructions SET last_evaluated_at_ms=? WHERE user_id=?")
        .bind(input.now.epochMilliseconds, input.userId)
        .run()
    );
    yield* noteBudgetCrossingEvaluation({ ...input, now: input.now.epochMilliseconds });
    const pending = recoverableOfferRequests(input.now);
    yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          `UPDATE proactivity_offer_requests SET last_evaluated_at_ms=? WHERE user_id=? AND id IN (SELECT id FROM (${pending.sql}) WHERE user_id=?)`
        )
        .bind(input.now.epochMilliseconds, input.userId, ...pending.params, input.userId)
        .run()
    );
    yield* Effect.tryPromise(() =>
      input.db
        .prepare("UPDATE reminder_schedules SET last_evaluated_at_ms=? WHERE user_id=?")
        .bind(input.now.epochMilliseconds, input.userId)
        .run()
    );
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
