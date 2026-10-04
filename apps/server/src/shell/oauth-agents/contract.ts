import { type Option, Schema } from "effect";
import { OAuthRecentActivity } from "~/core/audit/contract";
import { type UserId } from "~/core/identity/contract";
import {
  OAuthClientId,
  OAuthConnectionId,
  type OAuthCredentialId,
} from "~/core/oauth-agents/contract";
import type { CanonicalCapability } from "~/core/canonical-operations/contract";
import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api";
import { PATLifetimeDays, PATScope, PATScopes } from "~/core/tokens/contract";

export { OAuthConnectionId } from "~/core/oauth-agents/contract";

/** Admission facts only: every protected query rechecks this exact credential and grant at commit. */
export type OAuthCaller = Readonly<{
  oauthConnectionId: OAuthConnectionId;
  credentialId: OAuthCredentialId;
  userId: UserId;
  clientId: OAuthClientId;
  resource: typeof oauthResource;
  digest: Uint8Array;
  requiredScope: Option.Option<CanonicalCapability>;
}>;
/** User-owned OAuth authority lent to a protected owner statement, never browser authority. */
export type OAuthAuthority = Readonly<{
  table: "oauth_access_credentials";
  attribution: Readonly<{
    userId: UserId;
    connectionId: OAuthConnectionId;
    credentialId: OAuthCredentialId;
  }>;
  predicate: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
}>;
/** Fixed issuer and audience: neither Host nor forwarding headers select OAuth authority. */
export const oauthIssuer = "https://api.fidyapp.com";
export const oauthResource = `${oauthIssuer}/mcp`;
export const oauthPaths = {
  resource: "/.well-known/oauth-protected-resource/mcp",
  issuer: "/.well-known/oauth-authorization-server",
  register: "/oauth/register",
  authorize: "/oauth/authorize",
  token: "/oauth/token",
  mcp: "/mcp",
  review: "/web/oauth/review",
  cancel: "/web/oauth/cancel",
  connect: "/web/oauth/connect",
  connections: "/web/oauth/connections",
  revoke: "/web/oauth/revoke",
  revokeAll: "/web/oauth/revoke-all",
} as const;
export const OAuthSource = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u));
export const OAuthRequestId = Schema.String.check(Schema.isUUID());
const maximumUrlLength = 2048;
const maximumRedirects = 8;
const maximumScopeLength = 64;
const UrlClaim = Schema.NonEmptyString.check(Schema.isMaxLength(maximumUrlLength));
const nativeCallback = (value: string): boolean => {
  try {
    const url = new URL(value);
    return (
      url.href === value &&
      url.username === "" &&
      url.password === "" &&
      url.hash === "" &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["127.0.0.1", "[::1]"].includes(url.hostname)))
    );
  } catch {
    return false;
  }
};
export const OAuthRedirect = UrlClaim.check(Schema.makeFilter(nativeCallback));
/** Public native registration accepts only code/refresh grants and no client authentication. */
export const OAuthRegistration = Schema.Struct({
  client_name: Schema.NonEmptyString.check(
    Schema.isMaxLength(100),
    Schema.isPattern(/^[^\p{Cc}\p{Cf}]+$/u)
  ),
  redirect_uris: Schema.NonEmptyArray(OAuthRedirect).check(
    Schema.isUnique(),
    Schema.isMaxLength(maximumRedirects)
  ),
  grant_types: Schema.optionalKey(
    Schema.NonEmptyArray(Schema.Literals(["authorization_code", "refresh_token"])).check(
      Schema.isUnique(),
      Schema.isMaxLength(2)
    )
  ),
  response_types: Schema.optionalKey(Schema.Tuple([Schema.Literal("code")])),
  token_endpoint_auth_method: Schema.optionalKey(Schema.Literal("none")),
  application_type: Schema.optionalKey(Schema.Literal("native")),
});
export type OAuthRegistration = typeof OAuthRegistration.Type;
export const OAuthAuthorization = Schema.Struct({
  client_id: OAuthClientId,
  response_type: Schema.Literal("code"),
  redirect_uri: OAuthRedirect,
  resource: Schema.Literal(oauthResource),
  code_challenge_method: Schema.Literal("S256"),
  code_challenge: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u)),
  state: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(maximumUrlLength))),
  scope: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(maximumScopeLength))),
});
export type OAuthAuthorization = typeof OAuthAuthorization.Type;
export const OAuthReview = Schema.Struct({
  requestId: OAuthRequestId,
  claimedClientName: OAuthRegistration.fields.client_name,
  scopes: PATScopes,
  permissions: Schema.NonEmptyArray(
    Schema.Struct({ scope: PATScope, label: Schema.String, description: Schema.String })
  ).check(Schema.isMaxLength(3)),
  requestExpiresAt: Schema.DateTimeUtcFromString,
  reviewedAt: Schema.DateTimeUtcFromString,
  connectAvailable: Schema.Literal(true),
});
export type OAuthReview = typeof OAuthReview.Type;
export const OAuthReviewChoice = Schema.Struct({
  requestId: OAuthRequestId,
  scopes: PATScopes,
  lifetimeDays: PATLifetimeDays,
  reviewedAt: Schema.DateTimeUtcFromString,
  expiresAt: Schema.DateTimeUtcFromString,
});
export type OAuthReviewChoice = typeof OAuthReviewChoice.Type;
/** The sole code-bearing browser destination is the exact validated initiating callback. */
export const OAuthConnected = Schema.Struct({
  connectionId: OAuthConnectionId,
  callback: OAuthRedirect,
});
const invalidStatus = 400;
const unauthorizedStatus = 401;
const forbiddenStatus = 403;
const rateLimitedStatus = 429;
const unavailableStatus = 503;
const OAuthInvalid = Schema.Struct({ error: Schema.Literal("invalid_request") }).annotate({
  httpApiStatus: invalidStatus,
});
const OAuthUnauthenticated = Schema.Struct({ error: Schema.Literal("unauthenticated") }).annotate({
  httpApiStatus: unauthorizedStatus,
});
const OAuthForbidden = Schema.Struct({ error: Schema.Literal("forbidden_origin") }).annotate({
  httpApiStatus: forbiddenStatus,
});
const OAuthRateLimited = Schema.Struct({ error: Schema.Literal("slow_down") }).annotate({
  httpApiStatus: rateLimitedStatus,
});
const OAuthUnavailable = Schema.Struct({
  error: Schema.Literal("temporarily_unavailable"),
}).annotate({ httpApiStatus: unavailableStatus });
/** Safe connection identities remain distinct even when their unverified display names repeat. */
export const OAuthConnectionMetadata = Schema.Struct({
  connectionId: OAuthConnectionId,
  claimedClientName: OAuthRegistration.fields.client_name,
  scopes: PATScopes,
  permissions: OAuthReview.fields.permissions,
  expiresAt: Schema.DateTimeUtcFromString,
  state: Schema.Literals(["active", "expired", "revoked"]),
  recentActivity: OAuthRecentActivity,
});
export type OAuthConnectionMetadata = typeof OAuthConnectionMetadata.Type;
export const oauthConnectionPageSize = 25;
export const OAuthConnectionList = Schema.Struct({
  connections: Schema.Array(OAuthConnectionMetadata).check(
    Schema.isMaxLength(oauthConnectionPageSize)
  ),
  nextCursor: Schema.OptionFromNullOr(OAuthConnectionId),
});
export type OAuthConnectionList = typeof OAuthConnectionList.Type;
export const OAuthConnectionListQuery = Schema.Struct({
  after: Schema.OptionFromOptionalKey(OAuthConnectionId),
});
export const OAuthConnectionRevoke = Schema.Struct({ connectionId: OAuthConnectionId });
export const OAuthConnectionRevokeAll = Schema.Struct({});
const managementErrors = [
  OAuthInvalid,
  OAuthUnauthenticated,
  OAuthForbidden,
  OAuthRateLimited,
  OAuthUnavailable,
];
/** Fresh first-party browser management is deliberately outside the external agent catalog. */
export const OAuthConnectionsGroup = HttpApiGroup.make("oauthConnections")
  .add(
    HttpApiEndpoint.get("list", oauthPaths.connections, {
      query: OAuthConnectionListQuery,
      success: OAuthConnectionList,
      error: managementErrors,
    })
  )
  .add(
    HttpApiEndpoint.post("revoke", oauthPaths.revoke, {
      payload: OAuthConnectionRevoke,
      success: Schema.Struct({ revoked: Schema.Literal(true) }),
      error: managementErrors,
    })
  )
  .add(
    HttpApiEndpoint.post("revokeAll", oauthPaths.revokeAll, {
      payload: OAuthConnectionRevokeAll,
      success: Schema.Struct({ revoked: Schema.Literal(true) }),
      error: managementErrors,
    })
  );
/** Browser-only request review: these declarations never enter the canonical tool catalog. */
export const OAuthReviewGroup = HttpApiGroup.make("oauthReview")
  .add(
    HttpApiEndpoint.get("review", oauthPaths.review, {
      query: Schema.Struct({ requestId: OAuthRequestId }),
      success: OAuthReview,
      error: [
        OAuthInvalid,
        OAuthUnauthenticated,
        OAuthForbidden,
        OAuthRateLimited,
        OAuthUnavailable,
      ],
    })
  )
  .add(
    HttpApiEndpoint.post("cancel", oauthPaths.cancel, {
      payload: Schema.Struct({ requestId: OAuthRequestId }),
      success: Schema.Struct({ cancelled: Schema.Literal(true) }),
      error: [
        OAuthInvalid,
        OAuthUnauthenticated,
        OAuthForbidden,
        OAuthRateLimited,
        OAuthUnavailable,
      ],
    })
  )
  .add(
    HttpApiEndpoint.post("connect", oauthPaths.connect, {
      payload: OAuthReviewChoice,
      success: OAuthConnected,
      error: [
        OAuthInvalid,
        OAuthUnauthenticated,
        OAuthForbidden,
        OAuthRateLimited,
        OAuthUnavailable,
      ],
    })
  );
