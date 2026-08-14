import type { DisclosureDeliveryFailureReason } from "./disclosure-model";

export type KapsoMetaFailureDisposition = Readonly<{
  readonly safeReason: DisclosureDeliveryFailureReason;
  readonly automaticRetry: boolean;
}>;

const metaBusinessBlockedRecipientCode = 130_403;
const metaRecipientIsSenderCode = 131_021;
const metaRecipientUndeliverableCode = 131_026;
const metaRecipientStoppedMarketingCode = 131_050;
const metaAppRateLimitCode = 4;
const metaUserRateLimitCode = 17;
const metaPageRateLimitCode = 32;
const metaBusinessAccountRateLimitCode = 80_007;
const metaMessageThroughputLimitCode = 130_429;
const metaRecipientPairRateLimitCode = 131_056;
const metaPermissionDeniedCode = 10;
const metaExpiredAccessTokenCode = 190;
const metaMissingPermissionCode = 200;
const metaAccessDeniedCode = 131_005;
const metaUnknownErrorCode = 1;
const metaTemporaryServiceErrorCode = 2;
const metaUnknownSendFailureCode = 131_000;
const metaServiceUnavailableCode = 131_016;
const metaMaintenanceModeCode = 131_057;
const metaServerTemporarilyUnavailableCode = 133_004;
const metaReengagementWindowCode = 131_047;

const invalidRecipientCodes = new Set([
  metaBusinessBlockedRecipientCode,
  metaRecipientIsSenderCode,
  metaRecipientUndeliverableCode,
  metaRecipientStoppedMarketingCode,
]);
const rateLimitedCodes = new Set([
  metaAppRateLimitCode,
  metaUserRateLimitCode,
  metaPageRateLimitCode,
  metaBusinessAccountRateLimitCode,
  metaMessageThroughputLimitCode,
  metaRecipientPairRateLimitCode,
]);
const authenticationCodes = new Set([
  metaPermissionDeniedCode,
  metaExpiredAccessTokenCode,
  metaMissingPermissionCode,
  metaAccessDeniedCode,
]);
const unavailableCodes = new Set([
  metaUnknownErrorCode,
  metaTemporaryServiceErrorCode,
  metaUnknownSendFailureCode,
  metaServiceUnavailableCode,
  metaMaintenanceModeCode,
  metaServerTemporarilyUnavailableCode,
]);

/** Decides safe retry semantics for one documented Meta failure code; unknown codes are terminal. */
export const classifyKapsoMetaFailureCode = (code: number): KapsoMetaFailureDisposition => {
  if (invalidRecipientCodes.has(code)) {
    return { safeReason: "invalid_recipient", automaticRetry: false };
  }
  if (code === metaReengagementWindowCode) {
    return { safeReason: "conversation_window_closed", automaticRetry: false };
  }
  if (rateLimitedCodes.has(code)) return { safeReason: "rate_limited", automaticRetry: true };
  if (authenticationCodes.has(code)) {
    return { safeReason: "authentication_failed", automaticRetry: false };
  }
  if (unavailableCodes.has(code)) {
    return { safeReason: "provider_unavailable", automaticRetry: true };
  }
  return { safeReason: "invalid_response", automaticRetry: false };
};
