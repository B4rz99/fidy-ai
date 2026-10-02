import { Schema } from "effect";
import { type OwnedStatement } from "~/shell/_shared/owned-statement";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import {
  BillingAttempt,
  BillingAttemptId,
  BillingEmail,
  CardEnrollment,
  CardEnrollmentDecisions,
  CardEnrollmentId,
  CardPaymentSubmission,
  PaymentRequestId,
  SubscriptionOffers,
  SubscriptionStatus,
  UpgradeDestination,
  maximumTransientCardTokenCharacters,
} from "~/core/subscription/contract";
import { operationPolicy, patScoped } from "~/shell/_shared/operation-policy";
import { OperationResponse, Unavailable } from "~/shell/public-http/contract";
import { PriceId } from "~/core/subscription/reference";

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
      access: patScoped("read"),
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
      access: patScoped("read"),
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
      access: patScoped("read"),
      requiredTier: "free",
      agentConfirmation: "not-required",
      kind: "query",
    })
  );

/** Canonical Free operation group for discovering and presenting Subscription standing and offers. */
export const SubscriptionGroup = HttpApiGroup.make("subscription")
  .add(getUpgradeUrl)
  .add(listSubscriptionOffers)
  .add(getSubscriptionStatus);

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
export class CardEnrollmentInvalidApi extends Schema.Error<CardEnrollmentInvalidApi>(
  "CardEnrollmentInvalidApi"
)(InvalidFields, { httpApiStatus: 400 }) {}

/** Missing or expired WebSession authority at the dedicated enrollment boundary. */
export class CardEnrollmentUnauthenticatedApi extends Schema.Error<CardEnrollmentUnauthenticatedApi>(
  "CardEnrollmentUnauthenticatedApi"
)(InvalidFields, { httpApiStatus: 401 }) {}

/** Cross-origin enrollment attempt rejected before any provider or persistence effect. */
export class CardEnrollmentOriginRejectedApi extends Schema.Error<CardEnrollmentOriginRejectedApi>(
  "CardEnrollmentOriginRejectedApi"
)(InvalidFields, { httpApiStatus: 403 }) {}

/** Bounded-body rejection that does not parse or report the rejected secret-bearing body. */
export class CardEnrollmentPayloadTooLargeApi extends Schema.Error<CardEnrollmentPayloadTooLargeApi>(
  "CardEnrollmentPayloadTooLargeApi"
)(InvalidFields, { httpApiStatus: 413 }) {}

/** Non-JSON secret-bearing submission rejected without provider work. */
export class CardEnrollmentUnsupportedMediaTypeApi extends Schema.Error<CardEnrollmentUnsupportedMediaTypeApi>(
  "CardEnrollmentUnsupportedMediaTypeApi"
)(InvalidFields, { httpApiStatus: 415 }) {}

/** Bounded preparation-attempt pressure refuses before provider work, not as an outage. */
export class CardEnrollmentRateLimitedApi extends Schema.Error<CardEnrollmentRateLimitedApi>(
  "CardEnrollmentRateLimitedApi"
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
export class CardEnrollmentUnavailableApi extends Schema.Error<CardEnrollmentUnavailableApi>(
  "CardEnrollmentUnavailableApi"
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
export const PrepareCardEnrollmentPayload = Schema.Struct({ priceId: PriceId });

const TokenText = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(maximumTransientCardTokenCharacters)
);
const SubmitBase = {
  enrollmentId: CardEnrollmentId,
  paymentRequestId: PaymentRequestId,
  billingEmail: BillingEmail,
  decisions: CardEnrollmentDecisions,
};

/** Secret-bearing submission shape; reauthorization omits card material and reuses the source. */
export const SubmitCardEnrollmentPayload = Schema.Union([
  Schema.Struct({
    paymentSourceMode: Schema.Literal("create"),
    ...SubmitBase,
    cardToken: Schema.RedactedFromValue(TokenText),
  }),
  Schema.Struct({ paymentSourceMode: Schema.Literal("reuse"), ...SubmitBase }),
]);
export type SubmitCardEnrollmentPayload = typeof SubmitCardEnrollmentPayload.Type;

const directErrors = [
  CardEnrollmentInvalidApi,
  CardEnrollmentUnauthenticatedApi,
  CardEnrollmentOriginRejectedApi,
  CardEnrollmentPayloadTooLargeApi,
  CardEnrollmentUnsupportedMediaTypeApi,
  CardEnrollmentUnavailableApi,
  CardEnrollmentRateLimitedApi,
] as const;

/** Dedicated first-party browser operations; none join canonical agent or PAT surfaces. */
export const SubscriptionEnrollmentGroup = HttpApiGroup.make("subscriptionEnrollment")
  .add(
    HttpApiEndpoint.post("prepare", "/web/subscription/card-enrollments/prepare", {
      payload: PrepareCardEnrollmentPayload,
      success: CardEnrollment,
      error: directErrors,
    })
  )
  .add(
    HttpApiEndpoint.post("submit", "/web/subscription/card-enrollments/submit", {
      payload: SubmitCardEnrollmentPayload,
      success: CardPaymentSubmission,
      error: directErrors,
    })
  )
  .add(
    HttpApiEndpoint.get("status", "/web/subscription/card-enrollments/:enrollmentId", {
      params: { enrollmentId: CardEnrollmentId },
      success: CardEnrollment,
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

/** Direct no-store card enrollment API excluded from FidyApi, OpenAPI, agents, and PATs. */
export class SubscriptionEnrollmentApi extends HttpApi.make("subscriptionEnrollmentApi")
  .add(SubscriptionEnrollmentGroup)
  .annotate(OpenApi.Title, "fidy-ai Subscription enrollment API") {}

/** Group shape exported solely for deriving the first-party browser client. */
export type SubscriptionEnrollmentApiGroups =
  typeof SubscriptionEnrollmentApi extends HttpApi.HttpApi<infer _Identifier, infer Groups>
    ? Groups
    : never;

/** Shared bounded generic invalid response for raw direct-browser handlers. */
export const cardEnrollmentInvalidBody = { error: invalidError } as const;
/** Shared bounded provider/configuration outage response. */
export const cardEnrollmentUnavailableBody = { error: unavailableError } as const;
/** Shared bounded preparation-attempt refusal, distinct from provider/configuration outage. */
export const cardEnrollmentRateLimitedBody = { error: rateLimitedError } as const;

/** Live credential predicate composed into a Subscription read within the caller's atomic unit. */
export type SubscriptionReadAuthority = Readonly<{
  table: "pats" | "web_sessions";
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
