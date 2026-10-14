import { Effect, Schema } from "effect";
import { InsightUnavailable, type ProactivityDeliveryWork } from "../contract";
import type { UserId } from "../../../src/core/identity/contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { settleDeliveryWork } from "./proactivity-delivery-work";

type Delivery = Readonly<{ userId: UserId; work: ProactivityDeliveryWork; now: number }>;
/** Metadata is bounded to one native identity, never provider or transport claims. */
const deliveryMetadataQuery = (input: Delivery): OwnedStatement => {
  switch (input.work.kind) {
    case "proactivity-delivery":
      return {
        sql: "SELECT o.user_id,o.state,r.expires_at_ms,(r.text IS NOT NULL) AS content_available FROM proactivity_outbox AS o JOIN proactivity_reports AS r ON r.user_id=o.user_id AND r.delivery_id=o.delivery_id WHERE o.user_id=? AND o.delivery_id=?",
        params: [input.userId, input.work.id],
      };
    case "weekly-summary":
      return {
        sql: "SELECT o.user_id,o.state,r.expires_at_ms,1 AS content_available FROM weekly_summary_outbox AS o JOIN weekly_summary_reports AS r ON r.user_id=o.user_id AND r.insight_event_id=o.insight_event_id WHERE o.user_id=? AND o.insight_event_id=?",
        params: [input.userId, input.work.insightEventId],
      };
    case "weekly-question":
      return {
        sql: "SELECT user_id,state,created_at_ms+86400000 AS expires_at_ms,1 AS content_available FROM weekly_question_intents WHERE user_id=? AND id=?",
        params: [input.userId, input.work.id],
      };
  }
};

/** Exact unfinished, unexpired admission; never a recurring schedule or Workflow payload. */
export const queuedDeliveryQuery = (input: Delivery): OwnedStatement => {
  const metadata = deliveryMetadataQuery(input);
  return {
    sql: `SELECT user_id FROM (${metadata.sql}) WHERE state='ready' AND expires_at_ms>? AND content_available=1`,
    params: [...metadata.params, input.now],
  };
};

/** Finish expiry and replay from metadata without reopening personal content. */
export const continueQueuedDelivery = (
  input: Delivery & Readonly<{ db: D1Database }>
): Effect.Effect<boolean, InsightUnavailable> =>
  Effect.gen(function* () {
    const query = deliveryMetadataQuery(input);
    const raw = yield* Effect.tryPromise(() =>
      input.db
        .prepare(query.sql)
        .bind(...query.params)
        .first()
    );
    if (raw === null) return yield* new InsightUnavailable();
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        state: Schema.Literals(["ready", "started", "settled", "expired", "refused"]),
        expires_at_ms: Schema.Int,
      })
    )(raw);
    if (row.state !== "ready") return false;
    if (row.expires_at_ms <= input.now) {
      yield* settleDeliveryWork({ ...input, state: "expired" });
      return false;
    }
    return true;
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
