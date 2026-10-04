/**
 * Browser-safe view of the server-owned canonical surface. The `@fidy/server/client`
 * package export points here; callers derive their own client adapter, such as AtomHttpApi.Service,
 * from this one `FidyApi` value and provide the returned client authorization layer.
 */
export {
  makeTokenAuthorizationClientLive,
  TokenAuthorizationClientAnonymousLive,
} from "~/shell/authorization/runtime";
export { FidyApi, operationCatalog, type FidyApiGroups, type OperationId } from "~/shell/api";
export { decideOperationAccess } from "~/shell/canonical-policy/operations";
export {
  atomicBatchChildOperations,
  atomicBatchOperation,
  getAtomicBatchInputSchema,
  projectAtomicBatchSchemas,
} from "~/shell/operations/contract";
export {
  HostedTurnApi,
  HostedTurnRequest,
  HostedTurnReceipt,
  HostedTurnProposal,
  HostedTurnProcessing,
  HostedTurnProgressRequest,
  type HostedTurnApiGroups,
} from "~/shell/agent/contract";
export {
  OAuthConnectionId,
  OAuthConnectionList,
  OAuthConnectionListQuery,
  OAuthConnectionMetadata,
  OAuthRequestId,
  OAuthReview,
  OAuthReviewChoice,
} from "~/shell/oauth-agents/contract";
export { CanonicalAllowance, canonicalAllowanceHeaders } from "~/shell/quotas/contract";
export { isHttpOrigin, ResourceLimited } from "~/shell/public-http/contract";
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
  patPairingLifetime,
  PATRecipientLabel,
  PATScope,
  PATScopes,
  TokenBearer,
  TokenBearerFormat,
  TokenShortId,
  recipientLabelLimit,
} from "~/core/tokens/contract";
export { PATId } from "~/core/tokens/contract";
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
export {
  PATPairingApi,
  ClaimPATPairingPayload,
  PATPairingInvalidApi,
  PATPairingPollingRateLimitedApi,
  PATPairingRateLimitedApi,
  PATPairingUnavailableApi,
} from "~/shell/tokens/contract";
export { buildPATDisclosure, getTokenShortId, patScopeCopy } from "~/core/tokens/operations";
export { StagedStatementReference, SubmitForExtractionInput } from "~/core/ingestion/contract";
export type { CanonicalInput } from "~/shell/canonical-operations/contract";
export type { CanonicalSuccess } from "~/shell/canonical-operations/contract";
export {
  DashboardCatalogEntry,
  DashboardDocument,
  DashboardEdit,
  maximumSplitWeight,
  minimumSplitWeight,
  SplitWeight,
  WidgetId,
} from "~/core/dashboard/contract";
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
export { CompleteEmailReplacementPayload } from "~/shell/web-authentication/contract";
export { RequestEmailReplacementPayload } from "~/shell/email-authentication/contract";
export {
  emailReplacementPath,
  emailReplacementCompletionPath,
} from "~/shell/email-authentication/contract";
export { BillingAttemptId, PaymentRequestId } from "~/core/subscription/contract";
export type { SubscriptionStatus } from "~/core/subscription/contract";
export { PriceId } from "~/core/subscription/contract";
export { IanaTimeZone } from "~/core/_shared/context";
export { BackupRecoveryCode, RotatedBackupRecoveryCode } from "~/core/recovery/contract";
export {
  BillingEmail,
  EnrollmentAvailability,
  DaviplataOtpPolicy,
  PaymentEnrollment,
  EnrollmentDecisions,
  PaymentSubmission,
  PaymentEnrollmentId,
} from "~/core/subscription/contract";
export type {
  PaymentEnrollment as PaymentEnrollmentType,
  PaymentSubmission as PaymentSubmissionType,
  EnrollmentMethod,
} from "~/core/subscription/contract";
export {
  PaymentEnrollmentInvalidApi,
  PaymentEnrollmentUnavailableApi,
  SubscriptionEnrollmentApi,
  type SubscriptionEnrollmentApiGroups,
  type SubmitPaymentEnrollmentPayload,
} from "~/shell/subscription/contract";
export {
  BrowserLoginPairingInvalidApi,
  BrowserLoginPollingRateLimitedApi,
  BrowserPairingEmailAuthenticationInvalidApi,
  EmailReplacementFreshPairingRequiredApi,
  EmailReplacementInvalidApi,
  emailReplacementFreshBody,
  emailReplacementInvalidBody,
} from "~/shell/web-authentication/contract";
