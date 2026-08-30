import { jsonStringSchema } from "~/schema-compatibility";
import { DateTime, Effect, Option, Redacted, Result, Schema } from "effect";
import type { HttpServerRequest } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  CompleteEmailReplacementPayload,
  EmailReplacementFreshPairingRequiredApi,
  EmailReplacementInvalidApi,
  EmailReplacementOriginRejectedApi,
  EmailReplacementPayloadTooLargeApi,
  EmailReplacementUnsupportedMediaTypeApi,
  EmailVerificationInvalidApi,
  VerifyEmailEnrollmentPayload,
  WebAuthApi,
  emailReplacementFreshBody,
  emailReplacementInvalidBody,
  emailVerificationInvalidBody,
} from "~/web-auth-api";
import { collectBoundedBytes } from "~/shell/_shared/bounded-bytes";
import { completeVerifiedOnboarding } from "~/shell/onboarding/onboarding";
import { EmailVerificationCode } from "~/core/email-authentication/model";
import { webSessionCookieName } from "~/shell/_shared/authz";
import { externalEndpoints } from "~/shell/_shared/external-endpoints";
import { authenticateWebSession } from "~/shell/web-session/service";
import { completeEmailReplacement } from "./replacement-transition";

const maximumEmailVerificationRequestBytes = 128;
const decodeVerificationPayload = Schema.decodeUnknownResult(
  jsonStringSchema(VerifyEmailEnrollmentPayload),
  { onExcessProperty: "error" }
);
const invalidApi = (): EmailVerificationInvalidApi =>
  EmailVerificationInvalidApi.make(emailVerificationInvalidBody);

const handleVerification = Effect.fn("EmailAuthentication.handleVerification")(function* (
  payload: VerifyEmailEnrollmentPayload
) {
  return yield* completeVerifiedOnboarding({
    combinedCode: Redacted.make(payload.combinedCode),
  }).pipe(Effect.catchTag("VerificationRejected", invalidApi));
});

const readVerificationPayload = Effect.fn("EmailAuthentication.readVerificationPayload")(function* (
  request: HttpServerRequest.HttpServerRequest
) {
  const contentType = request.headers["content-type"];
  if (
    request.headers.origin === undefined ||
    contentType === undefined ||
    !contentType.toLowerCase().startsWith("application/json")
  ) {
    return yield* invalidApi();
  }
  const bytes = yield* collectBoundedBytes(
    request.stream,
    maximumEmailVerificationRequestBytes
  ).pipe(Effect.mapError(invalidApi));
  if (Option.isNone(bytes)) return yield* invalidApi();
  const payload = decodeVerificationPayload(new TextDecoder().decode(bytes.value));
  return yield* Result.match(payload, {
    onFailure: invalidApi,
    onSuccess: Effect.succeed,
  });
});

export const EmailOnboardingWebAuthHandlersLive = HttpApiBuilder.group(
  WebAuthApi,
  "emailOnboarding",
  (handlers) =>
    handlers.handleRaw("verifyEmail", ({ request }) =>
      Effect.flatMap(readVerificationPayload(request), handleVerification)
    )
);

const decodeReplacementPayload = Schema.decodeUnknownResult(
  jsonStringSchema(CompleteEmailReplacementPayload),
  { onExcessProperty: "error" }
);
const decodeReplacementCode = Schema.decodeUnknownResult(EmailVerificationCode);
const invalidReplacement = (): EmailReplacementInvalidApi =>
  EmailReplacementInvalidApi.make(emailReplacementInvalidBody);
const freshPairingRequired = (): EmailReplacementFreshPairingRequiredApi =>
  EmailReplacementFreshPairingRequiredApi.make(emailReplacementFreshBody);
const originRejected = (): EmailReplacementOriginRejectedApi =>
  EmailReplacementOriginRejectedApi.make(emailReplacementInvalidBody);
const payloadTooLarge = (): EmailReplacementPayloadTooLargeApi =>
  EmailReplacementPayloadTooLargeApi.make(emailReplacementInvalidBody);
const unsupportedMediaType = (): EmailReplacementUnsupportedMediaTypeApi =>
  EmailReplacementUnsupportedMediaTypeApi.make(emailReplacementInvalidBody);

const readReplacementCode = Effect.fn("EmailAuthentication.readReplacementCode")(function* (
  request: HttpServerRequest.HttpServerRequest
) {
  const { webOrigin } = yield* externalEndpoints.pipe(Effect.orDie);
  const contentType = request.headers["content-type"];
  if (request.headers.origin !== webOrigin) return yield* originRejected();
  if (contentType === undefined || !/^application\/json(?:\s*;.*)?$/iu.test(contentType)) {
    return yield* unsupportedMediaType();
  }
  const bytes = yield* collectBoundedBytes(
    request.stream,
    maximumEmailVerificationRequestBytes
  ).pipe(Effect.mapError(payloadTooLarge));
  if (Option.isNone(bytes)) return yield* payloadTooLarge();
  const decodedPayload = decodeReplacementPayload(new TextDecoder().decode(bytes.value));
  if (Result.isFailure(decodedPayload)) return yield* invalidReplacement();
  return yield* Result.match(decodeReplacementCode(decodedPayload.success.combinedCode), {
    onFailure: invalidReplacement,
    onSuccess: Effect.succeed,
  });
});

const completeReplacement = Effect.fn("EmailAuthentication.completeReplacement")(function* (
  request: HttpServerRequest.HttpServerRequest
) {
  const combinedCode = yield* readReplacementCode(request);
  const attemptedAt = yield* DateTime.now;
  const session = yield* authenticateWebSession(
    request.cookies[webSessionCookieName] ?? "",
    attemptedAt
  );
  if (Option.isNone(session)) {
    return yield* freshPairingRequired();
  }
  const result = yield* completeEmailReplacement({
    subjectUserId: session.value.subjectUserId,
    authorizingWebSessionId: session.value.webSessionId,
    attemptedAt,
    combinedCode: Redacted.make(combinedCode),
  });
  if (result === "fresh-pairing-required") {
    return yield* freshPairingRequired();
  }
  return result === "rejected" ? yield* invalidReplacement() : { status: "replaced" as const };
});

/** Implements the raw first-party browser completion boundary with bounded HTTP responses. */
export const EmailReplacementWebAuthHandlersLive = HttpApiBuilder.group(
  WebAuthApi,
  "emailReplacement",
  (handlers) => handlers.handleRaw("complete", ({ request }) => completeReplacement(request))
);
