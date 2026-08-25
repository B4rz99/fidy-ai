import { Effect, Option, Redacted, Result, Schema } from "effect";
import type { HttpServerRequest } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import {
  EmailVerificationInvalidApi,
  VerifyEmailEnrollmentPayload,
  WebAuthApi,
  emailVerificationInvalidBody,
} from "~/web-auth-api";
import { collectBoundedBytes } from "~/shell/_shared/bounded-bytes";
import { completeVerifiedOnboarding } from "~/shell/onboarding/onboarding";

const maximumEmailVerificationRequestBytes = 128;
const decodeVerificationPayload = Schema.decodeUnknownResult(
  Schema.fromJsonString(VerifyEmailEnrollmentPayload),
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
