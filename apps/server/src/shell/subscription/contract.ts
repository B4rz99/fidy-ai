import { Schema } from "effect";
import { type OwnedStatement } from "~/shell/owner-write/contract";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api";
import {
  BillingAttempt,
  BillingAttemptId,
  BillingEmail,
  EnrollmentAvailability,
  EnrollmentDecisions,
  EnrollmentMethod,
  PaymentEnrollment,
  PaymentEnrollmentId,
  PaymentRequestId,
  PaymentSubmission,
  PriceId,
  SubscriptionCancellation,
  SubscriptionOffers,
  SubscriptionStatus,
  UpgradeDestination,
  maximumTransientPaymentTokenCharacters,
} from "~/core/subscription/contract";
import { operationPolicy, userOwnedAgentScoped } from "~/shell/canonical-policy/contract";
import { NotFound, OperationResponse, Unavailable } from "~/shell/public-http/contract";

const getUpgradeUrl = HttpApiEndpoint.get("getUpgradeUrl", "/subscription/upgrade-url", {
  success: OperationResponse(UpgradeDestination),
})
  .annotate(
    OpenApi.Description,
    "Get the public web destination for starting Pro access. Use it after a Paywall or Free " +
      "allowance response when the User asks how to upgrade."
  )
  .annotateMerge(
    operationPolicy({
      access: userOwnedAgentScoped("read"),
      requiredTier: "free",
      agentConfirmation: "not-required",
      kind: "query",
    })
  );

const listSubscriptionOffers = HttpApiEndpoint.get(
  "listSubscriptionOffers",
  "/subscription/offers",
  { success: OperationResponse(SubscriptionOffers), error: Unavailable }
)
  .annotate(
    OpenApi.Description,
    "List the authoritative immutable Colombia Prices and renewal terms available before " +
      "payment-method enrollment."
  )
  .annotateMerge(
    operationPolicy({
      access: userOwnedAgentScoped("read"),
      requiredTier: "free",
      agentConfirmation: "not-required",
      kind: "query",
    })
  );

const getSubscriptionStatus = HttpApiEndpoint.get("getSubscriptionStatus", "/subscription/status", {
  success: OperationResponse(SubscriptionStatus),
  error: Unavailable,
})
  .annotate(
    OpenApi.Description,
    "Check your current trial and paid Subscription periods, AccessTier, and recent BillingAttempts. Use it to explain current access without treating exhausted allowances as a Paywall."
  )
  .annotateMerge(
    operationPolicy({
      access: userOwnedAgentScoped("read"),
      requiredTier: "free",
      agentConfirmation: "not-required",
      kind: "query",
    })
  );

const cancelSubscription = HttpApiEndpoint.post(
  "cancelSubscription",
  "/subscription/cancellation",
  {
    success: OperationResponse(SubscriptionCancellation),
    error: [NotFound, Unavailable],
  }
)
  .annotate(
    OpenApi.Description,
    "Cancel future Subscription renewals and detach the reusable PaymentSource. Preserve access through the already-paid period and all billing history."
  )
  .annotateMerge(
    operationPolicy({
      access: userOwnedAgentScoped("write"),
      requiredTier: "free",
      agentConfirmation: "required",
      kind: "mutation",
    })
  );

/** Canonical Free operation group for discovering and presenting Subscription standing and offers. */
export const SubscriptionGroup = HttpApiGroup.make("subscription")
  .add(getUpgradeUrl)
  .add(listSubscriptionOffers)
  .add(getSubscriptionStatus)
  .add(cancelSubscription);

const invalidError = {
  code: "card_enrollment_invalid",
  message: "La inscripción ya no es válida. Revisa la oferta e intenta de nuevo.",
} as const;
const rateLimitedError = {
  code: "card_enrollment_rate_limited",
  message: "Demasiados intentos de inscripción. Intenta más tarde.",
} as const;
const unavailableError = {
  code: "card_enrollment_unavailable",
  message: "La inscripción no está disponible temporalmente. Intenta más tarde.",
} as const;
const InvalidFields = {
  error: Schema.Struct({
    code: Schema.Literal(invalidError.code),
    message: Schema.Literal(invalidError.message),
  }),
};

/** Generic direct-browser refusal that never reflects a transient token or provider response. */
export class PaymentEnrollmentInvalidApi extends Schema.Error<PaymentEnrollmentInvalidApi>(
  "PaymentEnrollmentInvalidApi"
)(InvalidFields, { httpApiStatus: 400 }) {}

/** Missing or expired WebSession authority at the dedicated enrollment boundary. */
export class PaymentEnrollmentUnauthenticatedApi extends Schema.Error<PaymentEnrollmentUnauthenticatedApi>(
  "PaymentEnrollmentUnauthenticatedApi"
)(InvalidFields, { httpApiStatus: 401 }) {}

/** Cross-origin enrollment attempt rejected before any provider or persistence effect. */
export class PaymentEnrollmentOriginRejectedApi extends Schema.Error<PaymentEnrollmentOriginRejectedApi>(
  "PaymentEnrollmentOriginRejectedApi"
)(InvalidFields, { httpApiStatus: 403 }) {}

/** Bounded-body rejection that does not parse or report the rejected secret-bearing body. */
export class PaymentEnrollmentPayloadTooLargeApi extends Schema.Error<PaymentEnrollmentPayloadTooLargeApi>(
  "PaymentEnrollmentPayloadTooLargeApi"
)(InvalidFields, { httpApiStatus: 413 }) {}

/** Non-JSON secret-bearing submission rejected without provider work. */
export class PaymentEnrollmentUnsupportedMediaTypeApi extends Schema.Error<PaymentEnrollmentUnsupportedMediaTypeApi>(
  "PaymentEnrollmentUnsupportedMediaTypeApi"
)(InvalidFields, { httpApiStatus: 415 }) {}

/** Bounded preparation-attempt pressure refuses before provider work, not as an outage. */
export class PaymentEnrollmentRateLimitedApi extends Schema.Error<PaymentEnrollmentRateLimitedApi>(
  "PaymentEnrollmentRateLimitedApi"
)(
  {
    error: Schema.Struct({
      code: Schema.Literal(rateLimitedError.code),
      message: Schema.Literal(rateLimitedError.message),
    }),
  },
  { httpApiStatus: 429 }
) {}

/** Bounded provider/configuration outage response carrying no provider details. */
export class PaymentEnrollmentUnavailableApi extends Schema.Error<PaymentEnrollmentUnavailableApi>(
  "PaymentEnrollmentUnavailableApi"
)(
  {
    error: Schema.Struct({
      code: Schema.Literal(unavailableError.code),
      message: Schema.Literal(unavailableError.message),
    }),
  },
  { httpApiStatus: 503 }
) {}

/** Browser preparation request names only the immutable server-owned Price. */
export const PreparePaymentEnrollmentPayload = Schema.Struct({
  priceId: PriceId,
  method: EnrollmentMethod,
});

const TokenText = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(maximumTransientPaymentTokenCharacters)
);
const SubmitBase = {
  enrollmentId: PaymentEnrollmentId,
  paymentRequestId: PaymentRequestId,
  billingEmail: BillingEmail,
  decisions: EnrollmentDecisions,
};

/** Secret-bearing submission shape; reauthorization omits card material and reuses the source. */
export const SubmitPaymentEnrollmentPayload = Schema.Union([
  Schema.Struct({
    method: Schema.Literal("card"),
    paymentSourceMode: Schema.Literal("create"),
    ...SubmitBase,
    cardToken: Schema.RedactedFromValue(TokenText),
  }),
  Schema.Struct({
    method: Schema.Literal("nequi"),
    paymentSourceMode: Schema.Literal("create"),
    ...SubmitBase,
    nequiToken: Schema.RedactedFromValue(
      TokenText.check(Schema.isPattern(/^nequi_(?:test|prod)_[A-Za-z0-9_-]+$/u))
    ),
  }),
  Schema.Struct({
    method: Schema.Literal("daviplata"),
    paymentSourceMode: Schema.Literal("create"),
    ...SubmitBase,
    daviplataToken: Schema.RedactedFromValue(
      TokenText.check(Schema.isPattern(/^daviplata_(?:devtest|devint|prod)_[A-Za-z0-9_-]+$/u))
    ),
  }),
  Schema.Struct({ paymentSourceMode: Schema.Literal("reuse"), ...SubmitBase }),
]);
export type SubmitPaymentEnrollmentPayload = typeof SubmitPaymentEnrollmentPayload.Type;

const directErrors = [
  PaymentEnrollmentInvalidApi,
  PaymentEnrollmentUnauthenticatedApi,
  PaymentEnrollmentOriginRejectedApi,
  PaymentEnrollmentPayloadTooLargeApi,
  PaymentEnrollmentUnsupportedMediaTypeApi,
  PaymentEnrollmentUnavailableApi,
  PaymentEnrollmentRateLimitedApi,
] as const;

/** Dedicated first-party browser operations; none join canonical agent or PAT surfaces. */
export const SubscriptionEnrollmentGroup = HttpApiGroup.make("subscriptionEnrollment")
  .add(
    HttpApiEndpoint.get("availability", "/web/subscription/payment-enrollments/availability", {
      success: EnrollmentAvailability,
      error: directErrors,
    })
  )
  .add(
    HttpApiEndpoint.post("prepare", "/web/subscription/payment-enrollments/prepare", {
      payload: PreparePaymentEnrollmentPayload,
      success: PaymentEnrollment,
      error: directErrors,
    })
  )
  .add(
    HttpApiEndpoint.post("submit", "/web/subscription/payment-enrollments/submit", {
      payload: SubmitPaymentEnrollmentPayload,
      success: PaymentSubmission,
      error: directErrors,
    })
  )
  .add(
    HttpApiEndpoint.get("status", "/web/subscription/payment-enrollments/:enrollmentId", {
      params: { enrollmentId: PaymentEnrollmentId },
      success: PaymentEnrollment,
      error: directErrors,
    })
  )
  .add(
    HttpApiEndpoint.get("billingAttempt", "/web/subscription/billing-attempts/:billingAttemptId", {
      params: { billingAttemptId: BillingAttemptId },
      success: BillingAttempt,
      error: directErrors,
    })
  );

/** Direct no-store payment-source enrollment API excluded from FidyApi, OpenAPI, agents, and PATs. */
export class SubscriptionEnrollmentApi extends HttpApi.make("subscriptionEnrollmentApi")
  .add(SubscriptionEnrollmentGroup)
  .annotate(OpenApi.Title, "fidy-ai Subscription enrollment API") {}

/** Group shape exported solely for deriving the first-party browser client. */
export type SubscriptionEnrollmentApiGroups =
  typeof SubscriptionEnrollmentApi extends HttpApi.HttpApi<infer _Identifier, infer Groups>
    ? Groups
    : never;

/** Shared bounded generic invalid response for raw direct-browser handlers. */
export const paymentEnrollmentInvalidBody = { error: invalidError } as const;
/** Shared bounded provider/configuration outage response. */
export const paymentEnrollmentUnavailableBody = { error: unavailableError } as const;
/** Shared bounded preparation-attempt refusal, distinct from provider/configuration outage. */
export const paymentEnrollmentRateLimitedBody = { error: rateLimitedError } as const;

/** Live credential predicate composed into a Subscription read within the caller's atomic unit. */
export type SubscriptionReadAuthority = Readonly<{
  table: "pats" | "web_sessions" | "oauth_access_credentials";
  predicate: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
}>;

/**
 * A bounded read to commit with the caller's authority and required Audit evidence. Decode only
 * its ordered results after that same commit succeeds; no persistence shape leaves this owner.
 */
export type PreparedSubscriptionRead = Readonly<{
  statements: ReadonlyArray<OwnedStatement>;
  decode: (rows: ReadonlyArray<ReadonlyArray<unknown>>) => Schema.Json;
}>;
