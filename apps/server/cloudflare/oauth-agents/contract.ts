import type { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import type { OAuthReviewBinding } from "../oauth-confirmation/contract";
import type { CanonicalAdmissionUnavailable } from "../canonical-admission/contract";
import type { OAuthCaller } from "../../src/shell/oauth-agents/contract";
import type { OAuthCanonicalAdmission } from "../../src/shell/mcp/contract";
import { Context, Data, type Effect, Option } from "effect";

export class BootstrapUnavailable extends Data.TaggedError("BootstrapUnavailable")<{
  readonly cause: Option.Option<unknown>;
}> {}

export class OAuthMcpCallerUnavailable extends Data.TaggedError("OAuthMcpCallerUnavailable") {}

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
