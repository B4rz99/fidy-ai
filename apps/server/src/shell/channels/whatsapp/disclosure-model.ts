import { Schema } from "effect";
import { DisclosureDeliveryCorrelationToken } from "~/core/_shared/provider-message-evidence";
import { PendingConsentExchangeId } from "~/core/consent/model";

export { DisclosureDeliveryCorrelationToken } from "~/core/_shared/provider-message-evidence";

/** Stable identity of one provider call, retained only inside the delivery module. */
export const DisclosureDeliveryAttemptId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("DisclosureDeliveryAttemptId"))
  .annotate({ identifier: "DisclosureDeliveryAttemptId" });
export type DisclosureDeliveryAttemptId = typeof DisclosureDeliveryAttemptId.Type;

/** Bounded ordinal of one delivery attempt under the four-attempt retry policy. */
export const DisclosureDeliveryAttemptNumber = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 4 })
).pipe(Schema.brand("DisclosureDeliveryAttemptNumber"));
export type DisclosureDeliveryAttemptNumber = typeof DisclosureDeliveryAttemptNumber.Type;

/** Exact-attempt capability required by delivery-state mutations. */
export const DisclosureDeliveryAttemptCapability = Schema.Struct({
  exchangeId: PendingConsentExchangeId,
  attemptId: DisclosureDeliveryAttemptId,
  correlationToken: DisclosureDeliveryCorrelationToken,
});
export type DisclosureDeliveryAttemptCapability = typeof DisclosureDeliveryAttemptCapability.Type;

/** Safe operational reason retained after a provider send does not complete. */
export const DisclosureDeliveryFailureReason = Schema.Literals([
  "sandbox_bsuid_unsupported",
  "invalid_recipient",
  "conversation_window_closed",
  "rate_limited",
  "authentication_failed",
  "provider_unavailable",
  "timeout",
  "invalid_response",
]);
export type DisclosureDeliveryFailureReason = typeof DisclosureDeliveryFailureReason.Type;
