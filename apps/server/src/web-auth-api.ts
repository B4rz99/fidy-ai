import { Schema } from "effect";
import {
  HttpApi,
  HttpApiEndpoint,
  HttpApiGroup,
  HttpApiSchema,
  OpenApi,
} from "effect/unstable/httpapi";
import { UtcTimestamp } from "~/core/_shared/time";
import { StartedBrowserLoginPairing } from "~/core/browser-login/model";
import { browserLoginPollingIntervalSeconds } from "~/core/browser-login/rules";
import { BackupRecoveryCode } from "~/core/recovery/model";

const browserLoginUnavailableError = {
  code: "rate_limited",
  message: "El inicio de sesión no está disponible temporalmente. Intenta de nuevo más tarde.",
} as const;

const BrowserLoginUnavailableError = Schema.Struct({
  code: Schema.Literal(browserLoginUnavailableError.code),
  message: Schema.Literal(browserLoginUnavailableError.message),
});

/** Documented 429 shape; the handler adds Retry-After on its raw encoded response. */
export class BrowserLoginRateLimitedApi extends Schema.ErrorClass<BrowserLoginRateLimitedApi>(
  "BrowserLoginRateLimitedApi"
)({ error: BrowserLoginUnavailableError }, { httpApiStatus: 429 }) {}

/** Capacity exhaustion intentionally shares the generic public message. */
export class BrowserLoginUnavailableApi extends Schema.ErrorClass<BrowserLoginUnavailableApi>(
  "BrowserLoginUnavailableApi"
)({ error: BrowserLoginUnavailableError }, { httpApiStatus: 503 }) {}

/** Shared non-enumerating body encoded for both rate and capacity admission failures. */
export const browserLoginUnavailableBody = { error: browserLoginUnavailableError } as const;

const browserLoginPairingInvalidError = {
  code: "pairing_invalid",
  message: "Esta vinculación ya no es válida. Inicia de nuevo.",
} as const;

const BrowserLoginPairingInvalidError = Schema.Struct({
  code: Schema.Literal(browserLoginPairingInvalidError.code),
  message: Schema.Literal(browserLoginPairingInvalidError.message),
});

/** One non-enumerating public refusal for every invalid pairing proof and terminal state. */
export class BrowserLoginPairingInvalidApi extends Schema.ErrorClass<BrowserLoginPairingInvalidApi>(
  "BrowserLoginPairingInvalidApi"
)({ error: BrowserLoginPairingInvalidError }, { httpApiStatus: 400 }) {}

/** Polling cadence refusal; the global response adapter derives Retry-After from this body. */
export class BrowserLoginPollingRateLimitedApi extends Schema.ErrorClass<BrowserLoginPollingRateLimitedApi>(
  "BrowserLoginPollingRateLimitedApi"
)(
  {
    error: Schema.Struct({
      code: Schema.Literal("rate_limited"),
      retryAfterSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
    }),
  },
  { httpApiStatus: 429 }
) {}

/** Shared non-enumerating response body for every terminal redemption refusal. */
export const browserLoginPairingInvalidBody = {
  error: browserLoginPairingInvalidError,
} as const;

/** Proof-bearing HTTPS request; malformed field values receive the generic invalid response. */
export const RedeemBrowserLoginPairingPayload = Schema.Struct({
  pairingId: Schema.optional(Schema.Unknown),
  privateVerifier: Schema.optional(Schema.Unknown),
});
export type RedeemBrowserLoginPairingPayload = typeof RedeemBrowserLoginPairingPayload.Type;

/** Correct poll before hosted approval; HTTP 202 distinguishes pending from authenticated. */
export const PendingBrowserLoginPairing = Schema.Struct({
  status: Schema.Literal("pending_approval"),
  expiresAt: UtcTimestamp,
  pollingIntervalSeconds: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(browserLoginPollingIntervalSeconds)
  ),
}).annotate({ identifier: "PendingBrowserLoginPairing", httpApiStatus: 202 });
export type PendingBrowserLoginPairing = typeof PendingBrowserLoginPairing.Type;

/** Successful redemption carries no bearer or User material; the bearer exists only in a cookie. */
export const AuthenticatedBrowserLoginPairing = Schema.Struct({
  status: Schema.Literal("authenticated"),
}).annotate({ identifier: "AuthenticatedBrowserLoginPairing", httpApiStatus: 200 });
export type AuthenticatedBrowserLoginPairing = typeof AuthenticatedBrowserLoginPairing.Type;

/** Direct-browser login operations derived into server routes and one credential-bearing client. */
export const BrowserLoginWebAuthGroup = HttpApiGroup.make("browserLogin")
  .add(
    HttpApiEndpoint.post("startPairing", "/web/pairings", {
      success: StartedBrowserLoginPairing,
      error: [BrowserLoginRateLimitedApi, BrowserLoginUnavailableApi],
    }).annotate(
      OpenApi.Description,
      "Create one short-lived browser login pairing and return its private verifier once."
    )
  )
  .add(
    HttpApiEndpoint.post("redeemPairing", "/web/pairings/redeem", {
      payload: RedeemBrowserLoginPairingPayload,
      success: [PendingBrowserLoginPairing, AuthenticatedBrowserLoginPairing],
      error: [BrowserLoginPairingInvalidApi, BrowserLoginPollingRateLimitedApi],
    }).annotate(
      OpenApi.Description,
      "Poll one browser pairing and atomically redeem it after hosted approval."
    )
  )
  .add(
    HttpApiEndpoint.post("logout", "/web/session/logout", {
      success: HttpApiSchema.NoContent,
    }).annotate(OpenApi.Description, "Revoke the current browser WebSession and expire its cookie.")
  );

const emailVerificationInvalidError = {
  code: "verification_invalid",
  message: "El código no es válido. Revisa el correo o solicita uno nuevo.",
} as const;

/** One bounded raw browser field; proof parsing remains internal to the handler. */
export const VerifyEmailEnrollmentPayload = Schema.Struct({
  combinedCode: Schema.Unknown,
});
export type VerifyEmailEnrollmentPayload = typeof VerifyEmailEnrollmentPayload.Type;

/** One-time no-store disclosure of the Recovery-owned emergency credential. */
export const CreatedVerifiedOnboarding = Schema.Struct({
  status: Schema.Literal("created"),
  backupRecoveryCode: Schema.RedactedFromValue(BackupRecoveryCode),
}).annotate({ identifier: "CreatedVerifiedOnboarding" });

export class EmailVerificationInvalidApi extends Schema.ErrorClass<EmailVerificationInvalidApi>(
  "EmailVerificationInvalidApi"
)(
  {
    error: Schema.Struct({
      code: Schema.Literal(emailVerificationInvalidError.code),
      message: Schema.Literal(emailVerificationInvalidError.message),
    }),
  },
  { httpApiStatus: 400 }
) {}

export const emailVerificationInvalidBody = { error: emailVerificationInvalidError } as const;

export const EmailOnboardingWebAuthGroup = HttpApiGroup.make("emailOnboarding").add(
  HttpApiEndpoint.post("verifyEmail", "/web/onboarding/email/verify", {
    payload: VerifyEmailEnrollmentPayload,
    success: CreatedVerifiedOnboarding,
    error: EmailVerificationInvalidApi,
  }).annotate(
    OpenApi.Description,
    "Verify one mailbox proof and atomically create the complete stable User state."
  )
);

const emailReplacementInvalidError = {
  code: "verification_invalid",
  message: "El código no es válido. Revisa el correo o solicita uno nuevo.",
} as const;
const emailReplacementFreshError = {
  code: "fresh_pairing_required",
  message: "Vincula el navegador de nuevo antes de cambiar tu correo.",
} as const;

/** Body accepted by the first-party browser replacement-completion endpoint. */
export const CompleteEmailReplacementPayload = Schema.Struct({
  combinedCode: Schema.Unknown,
});
/** Decoded browser replacement-completion body. */
export type CompleteEmailReplacementPayload = typeof CompleteEmailReplacementPayload.Type;

/** Bounded success response for a completed credential replacement. */
export const CompletedEmailReplacement = Schema.Struct({
  status: Schema.Literal("replaced"),
}).annotate({ identifier: "CompletedEmailReplacement" });

const emailReplacementInvalidFields = {
  error: Schema.Struct({
    code: Schema.Literal(emailReplacementInvalidError.code),
    message: Schema.Literal(emailReplacementInvalidError.message),
  }),
};

/** Generic browser response for an invalid or unavailable replacement proof. */
export class EmailReplacementInvalidApi extends Schema.ErrorClass<EmailReplacementInvalidApi>(
  "EmailReplacementInvalidApi"
)(emailReplacementInvalidFields, { httpApiStatus: 400 }) {}

/** Browser response when replacement completion does not come from the first-party origin. */
export class EmailReplacementOriginRejectedApi extends Schema.ErrorClass<EmailReplacementOriginRejectedApi>(
  "EmailReplacementOriginRejectedApi"
)(emailReplacementInvalidFields, { httpApiStatus: 403 }) {}

/** Browser response when the replacement-completion body exceeds its fixed bound. */
export class EmailReplacementPayloadTooLargeApi extends Schema.ErrorClass<EmailReplacementPayloadTooLargeApi>(
  "EmailReplacementPayloadTooLargeApi"
)(emailReplacementInvalidFields, { httpApiStatus: 413 }) {}

/** Browser response when replacement completion is not encoded as JSON. */
export class EmailReplacementUnsupportedMediaTypeApi extends Schema.ErrorClass<EmailReplacementUnsupportedMediaTypeApi>(
  "EmailReplacementUnsupportedMediaTypeApi"
)(emailReplacementInvalidFields, { httpApiStatus: 415 }) {}

/** Browser response requiring the User to establish fresh WebSession authority again. */
export class EmailReplacementFreshPairingRequiredApi extends Schema.ErrorClass<EmailReplacementFreshPairingRequiredApi>(
  "EmailReplacementFreshPairingRequiredApi"
)(
  {
    error: Schema.Struct({
      code: Schema.Literal(emailReplacementFreshError.code),
      message: Schema.Literal(emailReplacementFreshError.message),
    }),
  },
  { httpApiStatus: 401 }
) {}

/** Shared bounded invalid-proof payload used by raw browser handlers. */
export const emailReplacementInvalidBody = { error: emailReplacementInvalidError } as const;
/** Shared bounded stale-authority payload used by raw browser handlers. */
export const emailReplacementFreshBody = { error: emailReplacementFreshError } as const;

/** First-party browser contract for completing verified-email replacement. */
export const EmailReplacementWebAuthGroup = HttpApiGroup.make("emailReplacement").add(
  HttpApiEndpoint.post("complete", "/web/email/replacement/verify", {
    payload: CompleteEmailReplacementPayload,
    success: CompletedEmailReplacement,
    error: [
      EmailReplacementInvalidApi,
      EmailReplacementFreshPairingRequiredApi,
      EmailReplacementOriginRejectedApi,
      EmailReplacementPayloadTooLargeApi,
      EmailReplacementUnsupportedMediaTypeApi,
    ],
  }).annotate(
    OpenApi.Description,
    "Consume one mailbox proof under the same User's currently fresh browser session."
  )
);

/** Direct browser authentication API. Secret-bearing responses never enter the canonical API. */
export class WebAuthApi extends HttpApi.make("webAuth")
  .add(BrowserLoginWebAuthGroup)
  .add(EmailOnboardingWebAuthGroup)
  .add(EmailReplacementWebAuthGroup)
  .annotate(OpenApi.Title, "fidy-ai WebAuth API") {}

/** Group shape exported for deriving the dedicated credential-bearing browser client. */
export type WebAuthApiGroups =
  typeof WebAuthApi extends HttpApi.HttpApi<infer _Identifier, infer Groups> ? Groups : never;
