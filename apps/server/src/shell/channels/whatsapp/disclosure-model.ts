import { Function, Schema } from "effect";
import { DisclosureDeliveryCorrelationToken } from "~/core/_shared/provider-message-evidence";
import { PendingConsentExchangeId } from "~/core/consent/model";

export { DisclosureDeliveryCorrelationToken } from "~/core/_shared/provider-message-evidence";

/** Stable identity of one provider call, retained only inside the delivery module. */
export const DisclosureDeliveryAttemptId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("DisclosureDeliveryAttemptId"))
  .annotate({ identifier: "DisclosureDeliveryAttemptId" });
export type DisclosureDeliveryAttemptId = typeof DisclosureDeliveryAttemptId.Type;

/**
 * Four-attempt retry policy bound, and the stride `disclosureActivityAttempt` interleaves it with.
 * Changing it changes persisted Activity identity, so suspended executions under an old bound must
 * be treated separately rather than resumed with the new bound's attempts.
 */
export const maximumDisclosureDeliveryAttempts = 4;

/** Bounded ordinal of one delivery attempt under the four-attempt retry policy. */
export const DisclosureDeliveryAttemptNumber = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: maximumDisclosureDeliveryAttempts })
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

/** Provider evidence lifecycle, independent of execution scheduling. */
export const DisclosureDeliveryState = Schema.Literals([
  "started",
  "reconciliation-required",
  "delivered",
  "definitively-failed",
  "retry-exhausted",
]);

/** Monotone observation version; duplicate provider evidence does not advance it. */
export const DisclosureEvidenceRevision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Deterministic identity of one durable Activity recurrence inside a single workflow execution. */
export const DisclosureActivityAttempt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).pipe(
  Schema.brand("DisclosureActivityAttempt")
);
export type DisclosureActivityAttempt = typeof DisclosureActivityAttempt.Type;

/**
 * Recurring durable steps keep one stable Activity name; their recurrence lives in
 * `Activity.CurrentAttempt`. Interleaving the bounded ordinal with the evidence revision that
 * authorized it keeps identity injective: a newer revision at the same ordinal is a distinct
 * durable step instead of a replayed armed-decline no-op. Uniqueness is what prevents aliasing;
 * per-attempt revisions restart, so ordering across ordinals is not load-bearing.
 */
export const disclosureActivityAttempt: {
  (
    evidenceRevision: number
  ): (attemptNumber: DisclosureDeliveryAttemptNumber) => DisclosureActivityAttempt;
  (
    attemptNumber: DisclosureDeliveryAttemptNumber,
    evidenceRevision: number
  ): DisclosureActivityAttempt;
} = Function.dual(2, (attemptNumber: DisclosureDeliveryAttemptNumber, evidenceRevision: number) =>
  DisclosureActivityAttempt.make(
    evidenceRevision * maximumDisclosureDeliveryAttempts + attemptNumber
  )
);

/** Safe latest-attempt observation used to decide durable continuation without replaying sends. */
export const DisclosureDeliveryEvidence = Schema.Struct({
  attemptId: DisclosureDeliveryAttemptId,
  attemptNumber: DisclosureDeliveryAttemptNumber,
  state: DisclosureDeliveryState,
  retryable: Schema.Boolean,
  reason: Schema.OptionFromNullOr(DisclosureDeliveryFailureReason),
  failureOccurredAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  evidenceRevision: DisclosureEvidenceRevision,
});
export type DisclosureDeliveryEvidence = typeof DisclosureDeliveryEvidence.Type;
