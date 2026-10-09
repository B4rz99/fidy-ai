import { DateTime, Effect, Option, Schema } from "effect";
import { decideConsentReply } from "../../../../src/shell/consent/operations";
import {
  DisclosureDeliveryCorrelationToken,
  PendingConsentExchangeId,
} from "../../../../src/shell/consent/contract";
import {
  type InvalidWhatsAppPayload,
  type WhatsAppDeliveryLookup,
  type WhatsAppDisclosureLifecycleEvidence,
  WhatsAppProviderMessageId,
  type WhatsAppStatusUnavailable,
} from "../../../../src/shell/channels/whatsapp/contract";
import { type WhatsAppAuthenticatedInbound } from "../../../whatsapp/contract";
import { admitStatusLookup } from "../../../whatsapp/operations";
import { type ConsentDeliveryInput } from "../contract";

const PendingDelivery = Schema.Struct({
  id: PendingConsentExchangeId,
  disclosure_message_id: WhatsAppProviderMessageId,
  correlation_token: DisclosureDeliveryCorrelationToken,
});

/** Reconcile only the authenticated sandbox caller's accepted send when delivery callbacks are
 * absent. One read per attempt/minute and 500/hour globally; never resend or accept Consent here.
 */
export const reconcileSandboxDelivery = Effect.fn(
  function* (
    input: Readonly<{
      db: D1Database;
      recordDelivery: (input: ConsentDeliveryInput) => Effect.Effect<Response, void>;
      sandboxPhoneNumberId: Option.Option<string>;
      inbound: WhatsAppAuthenticatedInbound;
      verify: (
        request: WhatsAppDeliveryLookup
      ) => Effect.Effect<
        Option.Option<WhatsAppDisclosureLifecycleEvidence>,
        InvalidWhatsAppPayload | WhatsAppStatusUnavailable
      >;
    }>
  ) {
    const { event } = input.inbound;
    if (
      !Option.contains(input.sandboxPhoneNumberId, event.businessPhoneNumberId) ||
      event.content._tag !== "Text"
    ) {
      return;
    }
    const decision = yield* decideConsentReply({ _tag: "Text", text: event.content.text });
    if (decision._tag === "Clarify") return;
    const row = yield* Effect.tryPromise(() =>
      input.db
        .prepare(`
    SELECT e.id,e.disclosure_message_id,e.correlation_token FROM pending_consent_exchanges e
    WHERE e.portfolio_id=? AND e.bsuid=? AND e.phone_number_id=?
      AND e.state='outbound_started' AND e.disclosure_message_id IS NOT NULL
      AND COALESCE(e.rejected_at_ms,e.expires_at_ms)>?
      AND NOT EXISTS(SELECT 1 FROM pending_consent_delivery d WHERE d.correlation_token=e.correlation_token)
    ORDER BY e.created_at_ms DESC LIMIT 1`)
        .bind(
          event.caller.businessPortfolioId,
          event.caller.businessScopedUserId,
          event.businessPhoneNumberId,
          input.inbound.receivedAtMs
        )
        .first()
    );
    if (row === null) return;
    const pending = yield* Schema.decodeUnknownEffect(PendingDelivery)(row);
    const request = {
      businessPhoneNumberId: event.businessPhoneNumberId,
      messageId: pending.disclosure_message_id,
      correlationToken: pending.correlation_token,
      receivedAt: event.receivedAt,
    };
    yield* admitStatusLookup({ database: input.db, request: { ...request, status: "delivered" } });
    const verified = yield* input.verify(request);
    if (Option.isNone(verified) || verified.value.outcome !== "accepted") return;
    yield* input.recordDelivery({
      correlationToken: pending.correlation_token,
      messageId: pending.disclosure_message_id,
      phoneNumberId: event.businessPhoneNumberId,
      occurredAtMs: DateTime.toEpochMillis(verified.value.occurredAt),
      receivedAtMs: input.inbound.receivedAtMs,
    });
  },
  (effect) => effect.pipe(Effect.ignoreCause)
);
