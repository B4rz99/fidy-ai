import { Effect, Schema } from "effect";
import { InsightUnavailable, type ProactivityDeliveryWork } from "../contract";
import type { UserId } from "../../../src/core/identity/contract";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { expireQueuedDelivery } from "./proactivity-delivery-work";

type Delivery = Readonly<{ userId: UserId; work: ProactivityDeliveryWork; now: number }>;

const deliveryMetadataQuery = (input: Delivery): OwnedStatement => ({
  sql: "SELECT user_id,state,expires_at_ms,content_available FROM proactivity_delivery_metadata WHERE user_id=? AND kind=? AND delivery_id=?",
  params: [
    input.userId,
    input.work.kind,
    input.work.kind === "weekly-summary" ? input.work.insightEventId : input.work.id,
  ],
});

export const queuedDeliveryQuery = (input: Delivery): OwnedStatement => {
  const metadata = deliveryMetadataQuery(input);
  return {
    sql: `SELECT user_id FROM (${metadata.sql}) WHERE state='ready' AND expires_at_ms>? AND content_available=1`,
    params: [...metadata.params, input.now],
  };
};

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
        content_available: Schema.Literals([0, 1]),
      })
    )(raw);
    if (row.state !== "ready") return false;
    if (row.expires_at_ms <= input.now) {
      yield* expireQueuedDelivery(input);
      return false;
    }
    return row.content_available === 1;
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
