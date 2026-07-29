import { Duration, Effect, Schema, Struct } from "effect";
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

/**
 * One persisted AgentToken grant without its bearer secret. `idleExpiresAt`
 * advances on use and auto-revokes the grant after 90 idle days;
 * `revokedAt` disables it earlier. Creation, use, idle expiry, and revocation
 * remain in lifecycle order, and ownership remains operation context.
 */
export const AgentToken = Schema.Struct({
  id: AgentTokenId,
  shortId: AgentTokenShortId,
  scopes: AgentTokenScopes,
  lastUsedAt: Schema.Option(AgentTokenTime),
  idleExpiresAt: AgentTokenTime,
  revokedAt: Schema.Option(AgentTokenTime),
  createdAt: AgentTokenTime,
})
  .check(validAgentTokenTimes)
  .annotate({ identifier: "AgentToken" });
export type AgentToken = typeof AgentToken.Type;

const AgentTokenAuthorizationFields = AgentToken.mapFields(Struct.pick(["id", "scopes"]));

/**
 * The authenticated AgentToken facts authorization needs after bearer lookup.
 * This projection carries the stable subject because resolving that association
 * is its purpose; it never leaves the process as a canonical response.
 */
export const ResolvedAgentToken = Schema.Struct({
  tokenId: AgentTokenAuthorizationFields.fields.id,
  subjectUserId: UserId,
  scopes: AgentTokenAuthorizationFields.fields.scopes,
  lastUsedAt: AgentTokenTime,
});
export type ResolvedAgentToken = typeof ResolvedAgentToken.Type;
