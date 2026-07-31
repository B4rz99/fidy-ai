import { Duration, Effect, Schema } from "effect";
import { AgentTokenId } from "~/core/_shared/agent-token";
import { UserId } from "~/core/_shared/user";

/**
 * One access capability an AgentToken may grant. Scopes are independent: a
 * caller receives only the canonical operations whose declared scope appears
 * in its token.
 */
export const AgentScope = Schema.Literals(["read", "write", "dashboard"]);
export type AgentScope = typeof AgentScope.Type;

/**
 * A non-empty set of AgentToken scopes. Duplicate entries are rejected so each
 * granted scope appears at most once; declaration order is retained.
 */
export const AgentTokenScopes = Schema.UniqueArray(AgentScope).check(Schema.isNonEmpty());
export type AgentTokenScopes = typeof AgentTokenScopes.Type;

const agentBearerPrefix = "fin_";
const agentTokenShortIdLength = 8;
const agentTokenShortIdPattern = `[a-z0-9]{${agentTokenShortIdLength}}`;
const agentBearerSecretPattern = "[A-Za-z0-9_-]{32,}";
/** Human-readable notation for the one AgentToken bearer encoding. */
export const AgentBearerTokenFormat = "fin_<short-id>_<secret>";

/**
 * The eight-character identifier embedded after `fin_` and safe to use when a
 * User names an AgentToken in chat. It identifies a grant, never authenticates
 * one.
 */
export const AgentTokenShortId = Schema.String.check(
  Schema.isPattern(new RegExp(`^${agentTokenShortIdPattern}$`))
).pipe(Schema.brand("AgentTokenShortId"));
export type AgentTokenShortId = typeof AgentTokenShortId.Type;

/** URL-safe high-entropy secret segment used only to construct an opaque bearer. */
export const AgentBearerSecret = Schema.String.check(
  Schema.isPattern(new RegExp(`^${agentBearerSecretPattern}$`))
).pipe(Schema.brand("AgentBearerSecret"));
export type AgentBearerSecret = typeof AgentBearerSecret.Type;

/**
 * The one-time opaque bearer presented by an agent. The `fin_` prefix and short
 * id make accidental disclosure recognizable; at least 32 URL-safe secret
 * characters supply authentication strength. Its secret and full encoding are
 * never persisted; storage retains only its hash and safe naming id.
 */
export const AgentBearerToken = Schema.String.check(
  Schema.isPattern(
    new RegExp(`^${agentBearerPrefix}${agentTokenShortIdPattern}_${agentBearerSecretPattern}$`)
  )
).pipe(Schema.brand("AgentBearerToken"));
export type AgentBearerToken = typeof AgentBearerToken.Type;

type AgentBearerSegments = Readonly<{
  shortId: Readonly<AgentTokenShortId>;
  secret: Readonly<AgentBearerSecret>;
}>;

/** Builds the sole valid opaque bearer encoding from its validated segments. */
export const makeAgentBearerToken = ({
  shortId,
  secret,
}: AgentBearerSegments): Effect.Effect<AgentBearerToken> =>
  Effect.succeed(AgentBearerToken.make(`${agentBearerPrefix}${String(shortId)}_${String(secret)}`));

/** Reads the safe naming id embedded in a previously validated opaque bearer. */
export const getAgentTokenShortId = (
  bearer: Readonly<AgentBearerToken>
): Effect.Effect<AgentTokenShortId> =>
  Effect.succeed(
    AgentTokenShortId.make(
      bearer.slice(agentBearerPrefix.length, agentBearerPrefix.length + agentTokenShortIdLength)
    )
  );

const AgentTokenTime = Schema.DateTimeUtc;

/** The rolling inactivity window after creation or the most recent use. */
export const AgentTokenIdleDuration = Duration.days(90);
const agentTokenIdleDurationMilliseconds = Duration.toMillis(AgentTokenIdleDuration);

type AgentTokenInstant = Readonly<{ epochMilliseconds: number }>;
type OptionalAgentTokenInstant =
  | Readonly<{ _tag: "None" }>
  | Readonly<{ _tag: "Some"; value: AgentTokenInstant }>;

const validAgentTokenTimes = Schema.makeFilter<
  Readonly<{
    lastUsedAt: OptionalAgentTokenInstant;
    idleExpiresAt: AgentTokenInstant;
    revokedAt: OptionalAgentTokenInstant;
    createdAt: AgentTokenInstant;
  }>
>((token) => {
  const createdAt = token.createdAt.epochMilliseconds;
  const lastUsedAt =
    token.lastUsedAt._tag === "Some" ? token.lastUsedAt.value.epochMilliseconds : createdAt;
  if (lastUsedAt < createdAt) {
    return {
      path: ["lastUsedAt"],
      issue: "AgentToken use cannot be before its creation time",
    };
  }
  const idleExpiresAt = token.idleExpiresAt.epochMilliseconds;
  if (idleExpiresAt !== lastUsedAt + agentTokenIdleDurationMilliseconds) {
    return {
      path: ["idleExpiresAt"],
      issue: "AgentToken idle expiry must be exactly 90 days after creation or last use",
    };
  }
  if (token.revokedAt._tag === "Some") {
    const revokedAt = token.revokedAt.value.epochMilliseconds;
    if (revokedAt < lastUsedAt) {
      return {
        path: ["revokedAt"],
        issue: "AgentToken revocation cannot be before its creation or last use",
      };
    }
  }
  return undefined;
});

const AgentTokenFields = {
  id: AgentTokenId,
  shortId: AgentTokenShortId,
  scopes: AgentTokenScopes,
  lastUsedAt: Schema.Option(AgentTokenTime),
  revokedAt: Schema.Option(AgentTokenTime),
  createdAt: AgentTokenTime,
};

/**
 * A User-minted AgentToken grant. Its idle deadline advances on use and
 * disables the grant after 90 inactive days; revocation can disable it sooner.
 */
export const UserAgentToken = Schema.TaggedStruct("UserAgentToken", {
  ...AgentTokenFields,
  idleExpiresAt: AgentTokenTime,
})
  .check(validAgentTokenTimes)
  .annotate({ identifier: "UserAgentToken" });
export type UserAgentToken = typeof UserAgentToken.Type;

const containsEveryAgentScope = Schema.makeFilter<AgentTokenScopes>((scopes) =>
  scopes.includes("read") && scopes.includes("write") && scopes.includes("dashboard")
    ? undefined
    : "A HostedAgentToken must grant every canonical AgentToken scope"
);

/** The fixed all-scope capability set carried only by a HostedAgentToken. */
export const HostedAgentScopes = AgentTokenScopes.check(containsEveryAgentScope).pipe(
  Schema.brand("HostedAgentScopes")
);
export type HostedAgentScopes = typeof HostedAgentScopes.Type;

const validHostedAgentTokenTimes = Schema.makeFilter<
  Readonly<{
    lastUsedAt: OptionalAgentTokenInstant;
    expiresAt: AgentTokenInstant;
    revokedAt: OptionalAgentTokenInstant;
    createdAt: AgentTokenInstant;
  }>
>((token) => {
  const createdAt = token.createdAt.epochMilliseconds;
  const expiresAt = token.expiresAt.epochMilliseconds;
  const lastUsedAt =
    token.lastUsedAt._tag === "Some" ? token.lastUsedAt.value.epochMilliseconds : createdAt;
  if (expiresAt <= createdAt) {
    return { path: ["expiresAt"], issue: "HostedAgentToken expiry must follow creation" };
  }
  if (lastUsedAt < createdAt || lastUsedAt >= expiresAt) {
    return { path: ["lastUsedAt"], issue: "HostedAgentToken use must be inside its hard lifetime" };
  }
  if (token.revokedAt._tag === "Some" && token.revokedAt.value.epochMilliseconds < lastUsedAt) {
    return { path: ["revokedAt"], issue: "HostedAgentToken revocation cannot precede its use" };
  }
  return undefined;
});

/**
 * An internal all-scope AgentToken created for one hosted turn. Its absolute
 * expiry never renews, and the turn revokes it sooner during normal cleanup.
 */
export const HostedAgentToken = Schema.TaggedStruct("HostedAgentToken", {
  ...AgentTokenFields,
  scopes: HostedAgentScopes,
  expiresAt: AgentTokenTime,
})
  .check(validHostedAgentTokenTimes)
  .annotate({ identifier: "HostedAgentToken" });
export type HostedAgentToken = typeof HostedAgentToken.Type;

/** Every persisted bearer grant accepted by canonical AgentAuthorization. */
export const AgentToken = Schema.Union([UserAgentToken, HostedAgentToken]).annotate({
  identifier: "AgentToken",
});
export type AgentToken = typeof AgentToken.Type;

/**
 * The authenticated AgentToken facts authorization needs after bearer lookup.
 * This resolution adds the stable subject and renames the canonical token id to
 * distinguish it from the User id; it never leaves the process as a response.
 */
export const ResolvedAgentToken = Schema.Struct({
  tokenId: AgentTokenFields.id,
  subjectUserId: UserId,
  scopes: AgentTokenFields.scopes,
  // Bearer resolution has already recorded this use, so the timestamp is present.
  lastUsedAt: AgentTokenTime,
});
export type ResolvedAgentToken = typeof ResolvedAgentToken.Type;
