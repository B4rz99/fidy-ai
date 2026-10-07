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
          "SELECT q.id,q.delivery_id FROM recurring_digest_opportunities AS o JOIN proactivity_offer_requests AS q ON q.user_id=o.user_id AND q.id=o.request_id WHERE o.user_id=?"
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
            `SELECT 1 FROM proactivity_reports AS r WHERE r.user_id=? AND r.delivery_id=? AND ((r.expires_at_ms<=? AND NOT EXISTS(SELECT 1 FROM (${started.sql}) AS c WHERE c.user_id=r.user_id AND c.delivery_id=r.delivery_id)) OR EXISTS(${rejected.sql}))`
          )
          .bind(input.userId, deliveryId, input.now.epochMilliseconds, ...rejected.params)
          .first()
      );
      if (retry === null) return;
    }
    yield* requestOffer(input);
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
