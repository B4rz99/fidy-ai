/**
 * Browser-safe view of the server-owned canonical surface. The future `@fidy/server/client`
 * package export points here; callers derive their own client adapter, such as AtomHttpApi.Service,
 * from this one `FidyApi` value and provide the returned client authorization layer.
 */
export {
  TokenAuthorizationClientAnonymousLive,
  makeTokenAuthorizationClientLive,
} from "~/shell/_shared/authz";

export { FidyApi, type FidyApiGroups, type OperationId } from "~/shell/api";

export {
  HostedTurnApi,
  HostedTurnProcessing,
  HostedTurnProgressRequest,
  HostedTurnProposal,
  HostedTurnReceipt,
  HostedTurnRequest,
  type HostedTurnApiGroups,
} from "~/shell/agent/hosted-turn-api";

export { isHttpOrigin } from "~/shell/public-http/contract";

export {
  ActivePATList,
  ActivePATMetadata,
  CreateManualPATPayload,
  IssuedPAT,
  ManualPATGrantInput,
  ManualPATRequestId,
  PATLifetimeDays,
  PATRecipientLabel,
  PATScope,
  PATScopes,
  TokenBearer,
  TokenBearerFormat,
  TokenShortId,
  countPATLabelCharacters,
  defaultPATLifetimeDays,
  patLifetimeDayOptions,
  recipientLabelLimit,
} from "~/core/tokens/model";

export { PATId } from "~/core/tokens/reference";

export {
  ApprovePATPairingPayload,
  ApprovedPATPairing,
  ClaimedPATPairing,
  PATPairingDeviceCode,
  PATPairingId,
  PATPairingPublicCode,
  PATPairingPublicCodeInput,
  PATPairingReview,
  PendingPATPairingClaim,
  StartPATPairingPayload,
  StartedPATPairing,
} from "~/core/tokens/pairing";

export { buildPATDisclosure, patScopeCopy } from "~/core/tokens/rules";

export { StagedStatementReference, SubmitForExtractionInput } from "~/core/ingestion/model";

export type { CanonicalInput } from "~/shell/_shared/canonical-input";

export type { CanonicalSuccess } from "~/shell/_shared/canonical-success";

export {
  DashboardCatalogEntry,
  DashboardDocument,
  DashboardEdit,
  SplitWeight,
  WidgetId,
  maximumSplitWeight,
  minimumSplitWeight,
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
} from "~/shell/web-authentication/contract";
export { StartedBrowserLoginPairing } from "~/core/browser-login/contract";
export { EmailAddress, EmailVerificationCode } from "~/core/email-authentication/contract";
export { CompleteEmailReplacementPayload } from "~/shell/email-authentication/contract";
export { RequestEmailReplacementPayload } from "~/shell/email-authentication/contract";

export {
  emailReplacementCompletionPath,
  emailReplacementPath,
} from "~/shell/email-authentication/contract";

export { BillingAttemptId, PaymentRequestId } from "~/core/subscription/model";

export type { SubscriptionStatus } from "~/core/subscription/model";

export { PriceId } from "~/core/subscription/reference";

export { IanaTimeZone } from "~/core/_shared/context";
export { BackupRecoveryCode, RotatedBackupRecoveryCode } from "~/core/recovery/contract";
export {
  BillingEmail,
  CardEnrollment,
  CardEnrollmentDecisions,
  CardEnrollmentId,
  CardPaymentSubmission,
} from "~/core/subscription/enrollment-model";

export type {
  CardEnrollment as CardEnrollmentType,
  CardPaymentSubmission as CardPaymentSubmissionType,
} from "~/core/subscription/enrollment-model";

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
} from "~/shell/web-authentication/contract";

export {
  EmailReplacementFreshPairingRequiredApi,
  EmailReplacementInvalidApi,
  emailReplacementFreshBody,
  emailReplacementInvalidBody,
} from "~/shell/email-authentication/contract";
