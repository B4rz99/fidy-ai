import { Effect, Option, Schema } from "effect";
import { findRecurringDiscovery } from "../../recurring/operations";
import {
  proactivityRejectedDeliveryQuery,
  proactivityStartedDeliveryQuery,
} from "../../whatsapp/operations";
import type { ProactivityConsentContext } from "../../consent/contract";
import { findProactivityConsentGrant } from "../../consent/operations";
import { offerWindowOpen, requestOffer } from "./proactivity-offers";
import { InsightUnavailable } from "../contract";

/** A fresh authenticated foreground interaction may disclose once; only definitive rejection or expiry before starting permits replacement. */
export const requestDiscoveryOffer = (
  input: ProactivityConsentContext & Readonly<{ messageId: string }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.gen(function* () {
    if (input.kind !== "new-recurring-series" || !offerWindowOpen(input.now)) return;
    if (Option.isNone(yield* findRecurringDiscovery(input))) return;
    if (Option.isSome(yield* findProactivityConsentGrant(input))) return;
    const raw = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          "SELECT id,delivery_id FROM (SELECT rowid,id,user_id,request_kind AS kind,request_message_id,created_at_ms,materialized_at_ms,last_evaluated_at_ms,offer_message_id AS delivery_id,current_recurring_opportunity FROM insight_offer_requests) WHERE user_id=? AND current_recurring_opportunity=1"
        )
        .bind(input.userId)
        .first()
    );
    if (raw !== null) {
      const row = yield* Schema.decodeUnknownEffect(
        Schema.Struct({ id: Schema.String, delivery_id: Schema.OptionFromNullOr(Schema.String) })
      )(raw);
      if (Option.isNone(row.delivery_id)) return;
      const deliveryId = row.delivery_id.value;
      const rejected = proactivityRejectedDeliveryQuery({ ...input, id: deliveryId });
      const started = proactivityStartedDeliveryQuery();
      const retry = yield* Effect.tryPromise(() =>
        input.db
          .prepare(
            `SELECT 1 FROM proactive_messages AS r WHERE r.kind='proactivity-delivery' AND r.scheduled_at_ms IS NOT NULL AND r.user_id=? AND r.id=? AND ((r.expires_at_ms<=? AND NOT EXISTS(SELECT 1 FROM (${started.sql}) AS c WHERE c.user_id=r.user_id AND c.delivery_id=r.id)) OR EXISTS(${rejected.sql}))`
          )
          .bind(input.userId, deliveryId, input.now.epochMilliseconds, ...rejected.params)
          .first()
      );
      if (retry === null) return;
    }
    yield* requestOffer(input);
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
