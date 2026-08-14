/**
 * Browser-safe view of the server-owned canonical surface. The future `@fidy/server/client`
 * package export points here; callers derive their own client adapter, such as AtomHttpApi.Service,
 * from this one `FidyApi` value and provide the returned client authorization layer.
 */
export { makeTokenAuthorizationClientLive } from "~/shell/_shared/authz";
export { FidyApi, type OperationId } from "~/shell/api";
export { TokenBearer, TokenBearerFormat } from "~/core/tokens/model";
export type { CanonicalInput } from "~/shell/_shared/canonical-input";
