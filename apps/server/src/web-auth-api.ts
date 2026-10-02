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

import {
  ApprovedBrowserPairingEmailAuthentication,
  BrowserPairingEmailAuthenticationInvalidApi,
  BrowserPairingEmailAuthenticationOriginRejectedApi,
  BrowserPairingEmailAuthenticationPayloadTooLargeApi,
  BrowserPairingEmailAuthenticationUnavailableApi,
  BrowserPairingEmailAuthenticationUnsupportedMediaTypeApi,
  CompleteBrowserPairingEmailAuthenticationPayload,
  EmailOnboardingWebAuthGroup,
  PendingBrowserPairingEmailAuthentication,
  StartBrowserPairingEmailAuthenticationPayload,
} from "~/shell/email-authentication/contract";

export {
  VerifyEmailEnrollmentPayload,
  CreatedVerifiedOnboarding,
  EmailVerificationInvalidApi,
  emailVerificationInvalidBody,
  EmailOnboardingWebAuthGroup,
  CompleteEmailReplacementPayload,
  CompletedEmailReplacement,
  EmailReplacementInvalidApi,
  EmailReplacementOriginRejectedApi,
  EmailReplacementPayloadTooLargeApi,
  EmailReplacementUnsupportedMediaTypeApi,
  EmailReplacementFreshPairingRequiredApi,
  emailReplacementInvalidBody,
  emailReplacementFreshBody,
  browserPairingEmailAuthenticationInvalidBody,
  StartBrowserPairingEmailAuthenticationPayload,
  CompleteBrowserPairingEmailAuthenticationPayload,
  PendingBrowserPairingEmailAuthentication,
  ApprovedBrowserPairingEmailAuthentication,
  BrowserPairingEmailAuthenticationInvalidApi,
  BrowserPairingEmailAuthenticationOriginRejectedApi,
  BrowserPairingEmailAuthenticationPayloadTooLargeApi,
  BrowserPairingEmailAuthenticationUnsupportedMediaTypeApi,
  BrowserPairingEmailAuthenticationUnavailableApi,
} from "~/shell/email-authentication/contract";

const browserLoginUnavailableError = {
  code: "rate_limited",
  message: "El inicio de sesión no está disponible temporalmente. Intenta de nuevo más tarde.",
} as const;

const BrowserLoginUnavailableError = Schema.Struct({
  code: Schema.Literal(browserLoginUnavailableError.code),
  message: Schema.Literal(browserLoginUnavailableError.message),
});

/** Documented 429 shape; the handler adds Retry-After on its raw encoded response. */
export class BrowserLoginRateLimitedApi extends Schema.Error<BrowserLoginRateLimitedApi>(
  "BrowserLoginRateLimitedApi"
)({ error: BrowserLoginUnavailableError }, { httpApiStatus: 429 }) {}

/** Capacity exhaustion intentionally shares the generic public message. */
export class BrowserLoginUnavailableApi extends Schema.Error<BrowserLoginUnavailableApi>(
  "BrowserLoginUnavailableApi"
)({ error: BrowserLoginUnavailableError }, { httpApiStatus: 503 }) {}

/** Shared non-enumerating response body for temporarily unavailable browser login admission. */
export const browserLoginUnavailableBody = Schema.encodeSync(
  Schema.toCodecJson(BrowserLoginUnavailableApi)
)(BrowserLoginUnavailableApi.make({ error: browserLoginUnavailableError }));

const browserLoginPairingInvalidError = {
  code: "pairing_invalid",
  message: "Esta vinculación ya no es válida. Inicia de nuevo.",
} as const;

const BrowserLoginPairingInvalidError = Schema.Struct({
  code: Schema.Literal(browserLoginPairingInvalidError.code),
  message: Schema.Literal(browserLoginPairingInvalidError.message),
});

/** One non-enumerating public refusal for every invalid pairing proof and terminal state. */
export class BrowserLoginPairingInvalidApi extends Schema.Error<BrowserLoginPairingInvalidApi>(
  "BrowserLoginPairingInvalidApi"
)({ error: BrowserLoginPairingInvalidError }, { httpApiStatus: 400 }) {}

/** Polling cadence refusal; the global response adapter derives Retry-After from this body. */
export class BrowserLoginPollingRateLimitedApi extends Schema.Error<BrowserLoginPollingRateLimitedApi>(
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
      error: [
        BrowserLoginPairingInvalidApi,
        BrowserLoginPollingRateLimitedApi,
        BrowserLoginUnavailableApi,
      ],
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

/** Direct-browser start and completion operations; neither operation creates a WebSession. */
export const BrowserPairingEmailAuthenticationWebAuthGroup = HttpApiGroup.make(
  "browserPairingEmailAuthentication"
)
  .add(
    HttpApiEndpoint.post("start", "/web/email/authentication/start", {
      payload: StartBrowserPairingEmailAuthenticationPayload,
      success: PendingBrowserPairingEmailAuthentication,
      error: [
        BrowserLoginPairingInvalidApi,
        BrowserPairingEmailAuthenticationInvalidApi,
        BrowserPairingEmailAuthenticationOriginRejectedApi,
        BrowserPairingEmailAuthenticationPayloadTooLargeApi,
        BrowserPairingEmailAuthenticationUnsupportedMediaTypeApi,
        BrowserPairingEmailAuthenticationUnavailableApi,
      ],
    })
  )
  .add(
    HttpApiEndpoint.post("complete", "/web/email/authentication/complete", {
      payload: CompleteBrowserPairingEmailAuthenticationPayload,
      success: ApprovedBrowserPairingEmailAuthentication,
      error: [
        BrowserPairingEmailAuthenticationInvalidApi,
        BrowserPairingEmailAuthenticationOriginRejectedApi,
        BrowserPairingEmailAuthenticationPayloadTooLargeApi,
        BrowserPairingEmailAuthenticationUnsupportedMediaTypeApi,
        BrowserPairingEmailAuthenticationUnavailableApi,
      ],
    })
  );

/** Direct browser authentication API. Secret-bearing responses never enter the canonical API. */
export class WebAuthApi extends HttpApi.make("webAuth")
  .add(BrowserLoginWebAuthGroup)
  .add(EmailOnboardingWebAuthGroup)
  .add(BrowserPairingEmailAuthenticationWebAuthGroup)
  .annotate(OpenApi.Title, "fidy-ai WebAuth API") {}

/** Group shape exported for deriving the dedicated credential-bearing browser client. */
export type WebAuthApiGroups =
  typeof WebAuthApi extends HttpApi.HttpApi<infer _Identifier, infer Groups> ? Groups : never;
