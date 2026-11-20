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

export class BootstrapUnavailable extends Data.TaggedError("BootstrapUnavailable") {}

export class OAuthQueryCallerUnavailable extends Data.TaggedError("OAuthQueryCallerUnavailable") {}

export class OAuthMcpCallerUnavailable extends Data.TaggedError("OAuthMcpCallerUnavailable") {}

export const OAuthMcpCallerFacts = Schema.Struct({
  scopes: PATScopes,
  tier: Schema.Literals(["free", "pro"]),
  credentialExpiresAt: Schema.DateTimeUtc,
  grantExpiresAt: Schema.DateTimeUtc,
});
export type OAuthMcpCallerFacts = typeof OAuthMcpCallerFacts.Type;

export const OAuthRevocationAdmission = Schema.Struct({
  userId: UserId,
  sessionId: WebSessionId,
  connectionId: Schema.OptionFromNullOr(OAuthConnectionId),
  deadlineAtMs: Schema.Int,
});
export type OAuthRevocationAdmission = typeof OAuthRevocationAdmission.Type;
const digestLength = 32;
const maximumScopeLength = 64;

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

export const CurrentOAuthInvocation = Context.Reference<Option.Option<LocalOAuthInvocation>>(
  "@fidy/cloudflare/CurrentOAuthInvocation",
  { defaultValue: Option.none }
);

export const oauthRouteCommandUrl = "https://directory.invalid/credentials/oauth";

export const oauthTokenDestinationUrl = "https://user.invalid/credentials/oauth/token";

export const oauthClientIdleMs = 2_592_000_000;
