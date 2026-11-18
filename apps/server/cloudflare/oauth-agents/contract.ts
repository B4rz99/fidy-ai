import type { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import type { OAuthReviewBinding } from "../oauth-confirmation/contract";
import type { CanonicalAdmissionUnavailable } from "../canonical-admission/contract";
import type { OAuthCaller } from "../../src/shell/oauth-agents/contract";
import type { OAuthCanonicalAdmission } from "../../src/shell/mcp/contract";
import { Context, Data, type Effect, Option, Schema } from "effect";
import { WebSessionId } from "../../src/core/web-session/contract";
import { UserId } from "../../src/core/identity/contract";
import {
  OAuthClientId,
  OAuthConnectionId,
  OAuthCredentialId,
} from "../../src/core/oauth-agents/contract";
import { oauthResource } from "../../src/shell/oauth-agents/contract";
import { PATScopes } from "../../src/core/tokens/contract";

/** OAuth bootstrap work could not complete; no credential outcome is implied. */
export class BootstrapUnavailable extends Data.TaggedError("BootstrapUnavailable") {}

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

export type LocalOAuthInvocation = {
  subject: OAuthCaller;
  admission: OAuthCanonicalAdmission;
  review: (
    current: number
  ) => Effect.Effect<
    Option.Option<OAuthReviewBinding>,
    CanonicalAdmissionUnavailable,
    SqliteClient
  >;
};

/** Only the native MCP transport installs a verified invocation for canonical dispatch. */
export const CurrentOAuthInvocation = Context.Reference<Option.Option<LocalOAuthInvocation>>(
  "@fidy/cloudflare/CurrentOAuthInvocation",
  { defaultValue: Option.none }
);

export const oauthRouteCommandUrl = "https://directory.invalid/credentials/oauth";

export const oauthTokenDestinationUrl = "https://user.invalid/credentials/oauth/token";

export const oauthClientIdleMs = 2_592_000_000;
