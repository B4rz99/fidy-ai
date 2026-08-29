/**
 * Browser-safe view of the server-owned canonical surface. The future `@fidy/server/client`
 * package export points here; callers derive their own client adapter, such as AtomHttpApi.Service,
 * from this one `FidyApi` value and provide the returned client authorization layer.
 */
export {
  makeTokenAuthorizationClientLive,
  TokenAuthorizationClientAnonymousLive,
} from "~/shell/_shared/authz";
export { FidyApi, type FidyApiGroups, type OperationId } from "~/shell/api";
export { isHttpOrigin } from "./http-origin";
export {
  ActivePATList,
  ActivePATMetadata,
  countPATLabelCharacters,
  CreateManualPATPayload,
  defaultPATLifetimeDays,
  IssuedPAT,
  ManualPATRequestId,
  ManualPATGrantInput,
  PATLifetimeDays,
  patLifetimeDayOptions,
  PATRecipientLabel,
  PATScope,
  PATScopes,
  TokenBearer,
  TokenBearerFormat,
  TokenShortId,
  recipientLabelLimit,
} from "~/core/tokens/model";
export { PATId } from "~/core/tokens/reference";
export {
  ApprovedPATPairing,
  ApprovePATPairingPayload,
  ClaimedPATPairing,
  PATPairingDeviceCode,
  PATPairingId,
  PATPairingPublicCode,
  PATPairingPublicCodeInput,
  PATPairingReview,
  PendingPATPairingClaim,
  StartedPATPairing,
  StartPATPairingPayload,
} from "~/core/tokens/pairing";
export { buildPATDisclosure, patScopeCopy } from "~/core/tokens/rules";
export type { CanonicalInput } from "~/shell/_shared/canonical-input";
export type { CanonicalSuccess } from "~/shell/_shared/canonical-success";
export {
  DashboardCatalogEntry,
  DashboardDocument,
  DashboardEdit,
  maximumSplitWeight,
  minimumSplitWeight,
  SplitWeight,
  WidgetId,
} from "~/core/dashboard/model";
export {
  ApprovedBrowserPairingEmailAuthentication,
  AuthenticatedBrowserLoginPairing,
  CompleteBrowserPairingEmailAuthenticationPayload,
  PendingBrowserLoginPairing,
  PendingBrowserPairingEmailAuthentication,
  RedeemBrowserLoginPairingPayload,
  StartBrowserPairingEmailAuthenticationPayload,
  WebAuthApi,
  type WebAuthApiGroups,
} from "./web-auth-api";
export { StartedBrowserLoginPairing } from "~/core/browser-login/model";
export { EmailAddress, EmailVerificationCode } from "~/core/email-authentication/model";
export { PriceId } from "~/core/subscription/reference";
export { BackupRecoveryCode, RotatedBackupRecoveryCode } from "~/core/recovery/model";
export {
  BillingEmail,
  CardEnrollment,
  CardEnrollmentDecisions,
  CardEnrollmentId,
} from "~/core/subscription/enrollment-model";
export type { CardEnrollment as CardEnrollmentType } from "~/core/subscription/enrollment-model";
export {
  CardEnrollmentInvalidApi,
  CardEnrollmentUnavailableApi,
  SubscriptionEnrollmentApi,
  type SubscriptionEnrollmentApiGroups,
} from "./subscription-enrollment-api";
export {
  BrowserLoginPairingInvalidApi,
  BrowserLoginPollingRateLimitedApi,
  BrowserPairingEmailAuthenticationInvalidApi,
  EmailReplacementFreshPairingRequiredApi,
  EmailReplacementInvalidApi,
} from "./web-auth-api";
