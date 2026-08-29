import { DateTime, Effect, Option, Result, Schema } from "effect";
import type { HttpServerRequest } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import type { SqlClient } from "effect/unstable/sql";
import type { UserId } from "~/core/identity/reference";
import {
  CardEnrollmentInvalidApi,
  CardEnrollmentOriginRejectedApi,
  CardEnrollmentPayloadTooLargeApi,
  CardEnrollmentUnauthenticatedApi,
  CardEnrollmentUnavailableApi,
  CardEnrollmentUnsupportedMediaTypeApi,
  PrepareCardEnrollmentPayload,
  SubmitCardEnrollmentPayload,
  SubscriptionEnrollmentApi,
  cardEnrollmentInvalidBody,
  cardEnrollmentUnavailableBody,
} from "~/subscription-enrollment-api";
import { webSessionCookieName } from "~/shell/_shared/authz";
import { collectBoundedBytes } from "~/shell/_shared/bounded-bytes";
import { externalEndpoints } from "~/shell/_shared/external-endpoints";
import { onboardingConsentStandingInScope, withSubjectLock } from "~/shell/consent/repo";
import { authenticateWebSession } from "~/shell/web-session/service";
import { getCardEnrollment, prepareCardEnrollment, submitCardEnrollment } from "./card-enrollment";

const maximumEnrollmentRequestBytes = 6144;
const decodePrepareEnrollmentPayload = Schema.decodeUnknownResult(
  Schema.fromJsonString(PrepareCardEnrollmentPayload),
  { onExcessProperty: "error" }
);
const decodeSubmit = Schema.decodeUnknownResult(
  Schema.fromJsonString(SubmitCardEnrollmentPayload),
  {
    onExcessProperty: "error",
  }
);

const invalid = (): CardEnrollmentInvalidApi =>
  CardEnrollmentInvalidApi.make(cardEnrollmentInvalidBody);
const unauthenticated = (): CardEnrollmentUnauthenticatedApi =>
  CardEnrollmentUnauthenticatedApi.make(cardEnrollmentInvalidBody);
const originRejected = (): CardEnrollmentOriginRejectedApi =>
  CardEnrollmentOriginRejectedApi.make(cardEnrollmentInvalidBody);
const payloadTooLarge = (): CardEnrollmentPayloadTooLargeApi =>
  CardEnrollmentPayloadTooLargeApi.make(cardEnrollmentInvalidBody);
const unsupportedMediaType = (): CardEnrollmentUnsupportedMediaTypeApi =>
  CardEnrollmentUnsupportedMediaTypeApi.make(cardEnrollmentInvalidBody);
const unavailable = (): CardEnrollmentUnavailableApi =>
  CardEnrollmentUnavailableApi.make(cardEnrollmentUnavailableBody);

const authorizeEnrollmentRequest = Effect.fn("Subscription.authorizeEnrollmentRequest")(function* (
  request: HttpServerRequest.HttpServerRequest
) {
  const { webOrigin } = yield* externalEndpoints.pipe(Effect.orDie);
  if (request.headers.origin !== webOrigin) return yield* originRejected();
  const now = yield* DateTime.now;
  const session = yield* authenticateWebSession(request.cookies[webSessionCookieName] ?? "", now);
  if (Option.isNone(session)) return yield* unauthenticated();
  if (DateTime.Order(now, session.value.freshUntil) >= 0) {
    return yield* unauthenticated();
  }
  return { userId: session.value.subjectUserId, now };
});

const withEnrollmentConsent = <A, E, R>(
  userId: UserId,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E | CardEnrollmentOriginRejectedApi, R | SqlClient.SqlClient> =>
  withSubjectLock(
    userId,
    Effect.gen(function* () {
      if ((yield* onboardingConsentStandingInScope(userId)) !== "granted") {
        return yield* originRejected();
      }
      return yield* effect;
    })
  );

const readJson = Effect.fn("Subscription.readEnrollmentJson")(function* (
  request: HttpServerRequest.HttpServerRequest
) {
  const contentType = request.headers["content-type"];
  if (contentType === undefined || !/^application\/json(?:\s*;.*)?$/iu.test(contentType)) {
    return yield* unsupportedMediaType();
  }
  const bytes = yield* collectBoundedBytes(request.stream, maximumEnrollmentRequestBytes).pipe(
    Effect.mapError(payloadTooLarge)
  );
  return Option.isSome(bytes) ? new TextDecoder().decode(bytes.value) : yield* payloadTooLarge();
});

const handlePrepare = Effect.fn("Subscription.handleEnrollmentPrepare")(function* (
  request: HttpServerRequest.HttpServerRequest
) {
  const authority = yield* authorizeEnrollmentRequest(request);
  const body = yield* readJson(request);
  const decoded = decodePrepareEnrollmentPayload(body);
  if (Result.isFailure(decoded)) return yield* invalid();
  return yield* withEnrollmentConsent(
    authority.userId,
    prepareCardEnrollment(authority.userId, decoded.success.priceId, authority.now).pipe(
      Effect.catchTags({
        CardEnrollmentInvalid: invalid,
        CardEnrollmentUnavailable: unavailable,
      })
    )
  );
});

const handleSubmit = Effect.fn("Subscription.handleEnrollmentSubmit")(function* (
  request: HttpServerRequest.HttpServerRequest
) {
  const authority = yield* authorizeEnrollmentRequest(request);
  const body = yield* readJson(request);
  const decoded = decodeSubmit(body);
  if (Result.isFailure(decoded)) return yield* invalid();
  const input =
    decoded.success.paymentSourceMode === "create"
      ? {
          paymentSourceMode: "create" as const,
          enrollmentId: decoded.success.enrollmentId,
          billingEmail: decoded.success.billingEmail,
          cardToken: decoded.success.cardToken,
        }
      : {
          paymentSourceMode: "reuse" as const,
          enrollmentId: decoded.success.enrollmentId,
          billingEmail: decoded.success.billingEmail,
        };
  return yield* withEnrollmentConsent(
    authority.userId,
    submitCardEnrollment(authority.userId, input, authority.now).pipe(
      Effect.catchTags({
        CardEnrollmentInvalid: invalid,
        CardEnrollmentUnavailable: unavailable,
      })
    )
  );
});

/** Implements the dedicated exact-origin, WebSession-authenticated, no-store enrollment API. */
export const SubscriptionEnrollmentHandlersLive = HttpApiBuilder.group(
  SubscriptionEnrollmentApi,
  "subscriptionEnrollment",
  (handlers) =>
    handlers
      .handleRaw("prepare", ({ request }) => handlePrepare(request))
      .handleRaw("submit", ({ request }) => handleSubmit(request))
      .handleRaw("status", ({ params, request }) =>
        Effect.flatMap(authorizeEnrollmentRequest(request), (authority) =>
          withEnrollmentConsent(
            authority.userId,
            getCardEnrollment(authority.userId, params.enrollmentId).pipe(
              Effect.catchTag("CardEnrollmentInvalid", invalid)
            )
          )
        )
      )
);
