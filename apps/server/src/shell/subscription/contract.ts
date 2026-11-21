import { type Brand, Schema } from "effect";
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
    "Check your current Pro access, trial and paid Subscription periods, and recent BillingAttempts. Use it to explain current access without treating exhausted allowances as a Paywall."
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

export class PaymentEnrollmentInvalidApi extends Schema.Error<
  PaymentEnrollmentInvalidApi,
  Brand.Brand<"PaymentEnrollmentInvalidApi">
>("PaymentEnrollmentInvalidApi")(InvalidFields, { httpApiStatus: 400 }) {}

export class PaymentEnrollmentUnauthenticatedApi extends Schema.Error<
  PaymentEnrollmentUnauthenticatedApi,
  Brand.Brand<"PaymentEnrollmentUnauthenticatedApi">
>("PaymentEnrollmentUnauthenticatedApi")(InvalidFields, { httpApiStatus: 401 }) {}

export class PaymentEnrollmentOriginRejectedApi extends Schema.Error<
  PaymentEnrollmentOriginRejectedApi,
  Brand.Brand<"PaymentEnrollmentOriginRejectedApi">
>("PaymentEnrollmentOriginRejectedApi")(InvalidFields, { httpApiStatus: 403 }) {}

export class PaymentEnrollmentPayloadTooLargeApi extends Schema.Error<
  PaymentEnrollmentPayloadTooLargeApi,
  Brand.Brand<"PaymentEnrollmentPayloadTooLargeApi">
>("PaymentEnrollmentPayloadTooLargeApi")(InvalidFields, { httpApiStatus: 413 }) {}

export class PaymentEnrollmentUnsupportedMediaTypeApi extends Schema.Error<
  PaymentEnrollmentUnsupportedMediaTypeApi,
  Brand.Brand<"PaymentEnrollmentUnsupportedMediaTypeApi">
>("PaymentEnrollmentUnsupportedMediaTypeApi")(InvalidFields, { httpApiStatus: 415 }) {}

export class PaymentEnrollmentRateLimitedApi extends Schema.Error<
  PaymentEnrollmentRateLimitedApi,
  Brand.Brand<"PaymentEnrollmentRateLimitedApi">
>("PaymentEnrollmentRateLimitedApi")(
  {
    error: Schema.Struct({
      code: Schema.Literal(rateLimitedError.code),
      message: Schema.Literal(rateLimitedError.message),
    }),
  },
  { httpApiStatus: 429 }
) {}

export class PaymentEnrollmentUnavailableApi extends Schema.Error<
  PaymentEnrollmentUnavailableApi,
  Brand.Brand<"PaymentEnrollmentUnavailableApi">
>("PaymentEnrollmentUnavailableApi")(
  {
    error: Schema.Struct({
      code: Schema.Literal(unavailableError.code),
      message: Schema.Literal(unavailableError.message),
    }),
  },
  { httpApiStatus: 503 }
) {}

export const PreparePaymentEnrollmentPayload = Schema.Struct({
  priceId: PriceId,
  method: EnrollmentMethod,
  replaceFailedSource: Schema.optionalKey(Schema.Boolean),
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
      TokenText.check(Schema.isPattern(/^daviplata_(?:test|devtest|devint|prod)_[A-Za-z0-9_-]+$/u))
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

export class SubscriptionEnrollmentApi extends HttpApi.make("subscriptionEnrollmentApi")
  .add(SubscriptionEnrollmentGroup)
  .annotate(OpenApi.Title, "fidy-ai Subscription enrollment API") {}

export type SubscriptionEnrollmentApiGroups =
  typeof SubscriptionEnrollmentApi extends HttpApi.HttpApi<infer _Identifier, infer Groups>
    ? Groups
    : never;

export const paymentEnrollmentInvalidBody = { error: invalidError } as const;

export const paymentEnrollmentUnavailableBody = { error: unavailableError } as const;

export const paymentEnrollmentRateLimitedBody = { error: rateLimitedError } as const;

export type SubscriptionReadAuthority = Readonly<{
  table: "pats" | "web_sessions" | "oauth_credentials" | "hosted_turns";
  predicate: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
}>;

export type PreparedSubscriptionRead = Readonly<{
  statements: ReadonlyArray<OwnedStatement>;
  decode: (rows: ReadonlyArray<ReadonlyArray<unknown>>) => Schema.Json;
}>;
