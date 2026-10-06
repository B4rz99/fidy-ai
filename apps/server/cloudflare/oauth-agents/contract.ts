import { Data, Schema } from "effect";
import { WebSessionId } from "../../src/core/web-session/contract";
import { UserId } from "../../src/core/identity/contract";
import {
  OAuthClientId,
  OAuthConnectionId,
  OAuthCredentialId,
} from "../../src/core/oauth-agents/contract";
import { oauthResource } from "../../src/shell/oauth-agents/contract";
import { PATScopes } from "../../src/core/tokens/contract";

/** OAuth-owned live caller facts could not be read; this is unavailable, not a dead credential. */
export class OAuthQueryCallerUnavailable extends Data.TaggedError("OAuthQueryCallerUnavailable") {}

/** Current native MCP projection failed; unavailable is distinct from an absent live credential. */
export class OAuthMcpCallerUnavailable extends Data.TaggedError("OAuthMcpCallerUnavailable") {}
/** Current capability facts and retained lifetime ceilings, not reusable execution authority. */
export const OAuthMcpCallerFacts = Schema.Struct({
  scopes: PATScopes,
  tier: Schema.Literals(["free", "pro"]),
  credentialExpiresAt: Schema.DateTimeUtc,
  grantExpiresAt: Schema.DateTimeUtc,
});
export type OAuthMcpCallerFacts = typeof OAuthMcpCallerFacts.Type;

/** Private first-party decision admission; only the original User coordinator may execute its live recheck. */
export const OAuthRevocationAdmission = Schema.Struct({
  userId: UserId,
  sessionId: WebSessionId,
  connectionId: Schema.OptionFromNullOr(OAuthConnectionId),
  deadlineAtMs: Schema.Int,
});
export type OAuthRevocationAdmission = typeof OAuthRevocationAdmission.Type;
const digestLength = 32;
const maximumScopeLength = 64;
/** Private refresh admission is verifier-only; the coordinator rechecks every binding at rotation. */
export const OAuthRefreshAdmission = Schema.Struct({
  deadlineAtMs: Schema.Int,
  userId: UserId,
  connectionId: OAuthConnectionId,
  credentialId: OAuthCredentialId,
  clientId: OAuthClientId,
  resource: Schema.Literal(oauthResource),
  digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))).check(
    Schema.isBetweenLength(digestLength, digestLength)
  ),
  scope: Schema.OptionFromOptionalKey(
    Schema.NonEmptyString.check(Schema.isMaxLength(maximumScopeLength))
  ),
});
export type OAuthRefreshAdmission = typeof OAuthRefreshAdmission.Type;
