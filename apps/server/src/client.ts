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
export {
  HostedTurnApi,
  HostedTurnRequest,
  HostedTurnReceipt,
  HostedTurnProposal,
  HostedTurnProcessing,
  HostedTurnProgressRequest,
  type HostedTurnApiGroups,
} from "~/shell/agent/hosted-turn-api";
export { isHttpOrigin } from "~/shell/public-http/contract";
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
} from "~/core/tokens/contract";
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
} from "~/core/tokens/contract";
export { buildPATDisclosure, patScopeCopy } from "~/core/tokens/operations";
export { StagedStatementReference, SubmitForExtractionInput } from "~/core/ingestion/model";
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
export { EmailAddress, EmailVerificationCode } from "~/core/email-authentication/contract";
export { CompleteEmailReplacementPayload } from "./web-auth-api";
export { RequestEmailReplacementPayload } from "~/shell/email-authentication/contract";
export {
  emailReplacementPath,
  emailReplacementCompletionPath,
} from "~/shell/email-authentication/contract";
export { BillingAttemptId, PaymentRequestId } from "~/core/subscription/contract";
export type { SubscriptionStatus } from "~/core/subscription/contract";
export { PriceId } from "~/core/subscription/reference";
export { IanaTimeZone } from "~/core/_shared/context";
export { BackupRecoveryCode, RotatedBackupRecoveryCode } from "~/core/recovery/model";
export {
  BillingEmail,
  CardEnrollment,
  CardEnrollmentDecisions,
  CardPaymentSubmission,
  CardEnrollmentId,
} from "~/core/subscription/contract";
export type {
  CardEnrollment as CardEnrollmentType,
  CardPaymentSubmission as CardPaymentSubmissionType,
} from "~/core/subscription/contract";
export {
  CardEnrollmentInvalidApi,
  CardEnrollmentUnavailableApi,
  SubscriptionEnrollmentApi,
  type SubscriptionEnrollmentApiGroups,
} from "~/shell/subscription/contract";
export {
  BrowserLoginPairingInvalidApi,
  BrowserLoginPollingRateLimitedApi,
  BrowserPairingEmailAuthenticationInvalidApi,
  EmailReplacementFreshPairingRequiredApi,
  EmailReplacementInvalidApi,
  emailReplacementFreshBody,
  emailReplacementInvalidBody,
} from "./web-auth-api";
