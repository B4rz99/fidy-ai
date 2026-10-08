import { OAuthConnectionsGroup, OAuthReviewGroup } from "~/shell/oauth-agents/contract";
import { HttpApi, OpenApi } from "effect/http-api";
import { BrowserLoginWebAuthGroup } from "~/shell/browser-login/contract";
import {
  BrowserPairingEmailAuthenticationWebAuthGroup,
  EmailAuthenticationGroup,
  EmailOnboardingWebAuthGroup,
} from "~/shell/email-authentication/contract";
import { IdentityGroup } from "~/shell/identity/contract";
import { RecoveryGroup } from "~/shell/recovery/contract";
import { ConnectionBrowserApi } from "~/shell/connections/contract";

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

export { BrowserPairingEmailAuthenticationWebAuthGroup } from "~/shell/email-authentication/contract";

/** Direct browser authentication API. Secret-bearing responses never enter the canonical API. */
export class WebAuthApi extends HttpApi.make("webAuth")
  .add(BrowserLoginWebAuthGroup)
  .add(OAuthReviewGroup)
  .add(OAuthConnectionsGroup)
  .addHttpApi(ConnectionBrowserApi)
  .add(EmailOnboardingWebAuthGroup)
  .add(BrowserPairingEmailAuthenticationWebAuthGroup)
  .annotate(OpenApi.Title, "fidy-ai WebAuth API") {}

/** Group shape exported for deriving the dedicated credential-bearing browser client. */
export type WebAuthApiGroups =
  typeof WebAuthApi extends HttpApi.HttpApi<infer _Identifier, infer Groups> ? Groups : never;

/** Owner-declared browser protocol paths; this projection grants no proof or session authority. */
export const webAuthenticationEndpoints = {
  startPairing: BrowserLoginWebAuthGroup.endpoints.startPairing,
  redeemPairing: BrowserLoginWebAuthGroup.endpoints.redeemPairing,
  logout: BrowserLoginWebAuthGroup.endpoints.logout,
  verifyEmail: EmailOnboardingWebAuthGroup.endpoints.verifyEmail,
  startEmail: BrowserPairingEmailAuthenticationWebAuthGroup.endpoints.start,
  completeEmail: BrowserPairingEmailAuthenticationWebAuthGroup.endpoints.complete,
  requestReplacement: EmailAuthenticationGroup.endpoints.requestEmailReplacement,
  completeReplacement: EmailAuthenticationGroup.endpoints.completeEmailReplacement,
  rotateRecovery: RecoveryGroup.endpoints.rotateBackupRecoveryCode,
  currentUser: IdentityGroup.endpoints.getCurrentUser,
} as const;
