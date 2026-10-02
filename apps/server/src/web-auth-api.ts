import {
  BrowserLoginPairingInvalidApi,
  BrowserLoginWebAuthGroup,
} from "~/shell/browser-login/contract";

import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi";

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
  BrowserLoginWebAuthGroup,
  BrowserLoginRateLimitedApi,
  BrowserLoginUnavailableApi,
  browserLoginUnavailableBody,
  BrowserLoginPairingInvalidApi,
  BrowserLoginPollingRateLimitedApi,
  browserLoginPairingInvalidBody,
  RedeemBrowserLoginPairingPayload,
  PendingBrowserLoginPairing,
  AuthenticatedBrowserLoginPairing,
} from "~/shell/browser-login/contract";

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
