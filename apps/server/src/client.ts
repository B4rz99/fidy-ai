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
  countPATLabelCharacters,
  CreateManualPATPayload,
  IssuedManualPAT,
  ManualPATRequestId,
  ManualPATGrantInput,
  PATRecipientLabel,
  PATScope,
  PATScopes,
  TokenBearer,
  TokenBearerFormat,
  TokenShortId,
  recipientLabelLimit,
} from "~/core/tokens/model";
export { PATId } from "~/core/tokens/reference";
export { buildPATDisclosure, patScopeCopy } from "~/core/tokens/rules";
export type { CanonicalInput } from "~/shell/_shared/canonical-input";
export type { CanonicalSuccess } from "~/shell/_shared/canonical-success";
export {
  AuthenticatedBrowserLoginPairing,
  PendingBrowserLoginPairing,
  RedeemBrowserLoginPairingPayload,
  WebAuthApi,
  type WebAuthApiGroups,
} from "./web-auth-api";
export { StartedBrowserLoginPairing } from "~/core/browser-login/model";
export { PriceRevisionId } from "~/core/subscription/reference";
export { BrowserLoginPairingInvalidApi, BrowserLoginPollingRateLimitedApi } from "./web-auth-api";
