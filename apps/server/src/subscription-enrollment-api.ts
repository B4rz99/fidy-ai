import { SchemaSerializableError } from "./schema-compatibility";
import { Schema } from "effect";
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";
import {
  BillingEmail,
  CardEnrollment,
  CardEnrollmentDecisions,
  CardEnrollmentId,
  maximumTransientCardTokenCharacters,
} from "~/core/subscription/enrollment-model";
import { PriceId } from "~/core/subscription/reference";

const invalidError = {
  code: "card_enrollment_invalid",
  message: "La inscripción ya no es válida. Revisa la oferta e intenta de nuevo.",
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
export class CardEnrollmentInvalidApi extends SchemaSerializableError<CardEnrollmentInvalidApi>(
  "CardEnrollmentInvalidApi"
)(InvalidFields, { httpApiStatus: 400 }) {}

/** Missing or expired WebSession authority at the dedicated enrollment boundary. */
export class CardEnrollmentUnauthenticatedApi extends SchemaSerializableError<CardEnrollmentUnauthenticatedApi>(
  "CardEnrollmentUnauthenticatedApi"
)(InvalidFields, { httpApiStatus: 401 }) {}

/** Cross-origin enrollment attempt rejected before any provider or persistence effect. */
export class CardEnrollmentOriginRejectedApi extends SchemaSerializableError<CardEnrollmentOriginRejectedApi>(
  "CardEnrollmentOriginRejectedApi"
)(InvalidFields, { httpApiStatus: 403 }) {}

/** Bounded-body rejection that does not parse or report the rejected secret-bearing body. */
export class CardEnrollmentPayloadTooLargeApi extends SchemaSerializableError<CardEnrollmentPayloadTooLargeApi>(
  "CardEnrollmentPayloadTooLargeApi"
)(InvalidFields, { httpApiStatus: 413 }) {}

/** Non-JSON secret-bearing submission rejected without provider work. */
export class CardEnrollmentUnsupportedMediaTypeApi extends SchemaSerializableError<CardEnrollmentUnsupportedMediaTypeApi>(
  "CardEnrollmentUnsupportedMediaTypeApi"
)(InvalidFields, { httpApiStatus: 415 }) {}

/** Bounded provider/configuration outage response carrying no provider details. */
export class CardEnrollmentUnavailableApi extends SchemaSerializableError<CardEnrollmentUnavailableApi>(
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
      success: CardEnrollment,
      error: directErrors,
    })
  )
  .add(
    HttpApiEndpoint.get("status", "/web/subscription/card-enrollments/:enrollmentId", {
      params: { enrollmentId: CardEnrollmentId },
      success: CardEnrollment,
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
