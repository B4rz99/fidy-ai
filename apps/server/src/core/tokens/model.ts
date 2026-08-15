import { Duration, Effect, Schema } from "effect";
import { HostedTurnTokenId, PATId } from "./reference";
import { UserId } from "~/core/identity/reference";
import { UtcTimestamp } from "~/core/_shared/time";

const CanonicalScope = Schema.Literals(["read", "write", "dashboard"]);

/**
 * One access capability a User may grant to a PAT. Scopes are independent: a
 * caller receives only the canonical operations whose declared scope appears
 * in its PAT.
 */
export const PatScope = CanonicalScope.annotate({ identifier: "PatScope" });
export type PatScope = typeof PatScope.Type;

/**
 * A non-empty set of PAT scopes. Duplicate entries are rejected so each
 * granted scope appears at most once; declaration order is retained.
 */
export const PatScopes = Schema.UniqueArray(PatScope).check(Schema.isNonEmpty());
export type PatScopes = typeof PatScopes.Type;

const bearerPrefix = "fin_";
const patShortIdLength = 8;
const patShortIdPattern = `[a-z0-9]{${patShortIdLength}}`;
const bearerSecretPattern = "[A-Za-z0-9_-]{32,}";
const patIdleDays = 90;
/** Human-readable notation for the one opaque bearer encoding. */
export const TokenBearerFormat = "fin_<short-id>_<secret>";

/** Random bytes a caller must draw for one bearer secret before encoding it. */
export const bearerSecretBytes = 32;

/**
 * The eight-character identifier embedded after `fin_` and safe to use when a
 * User names a PAT in chat. It identifies a grant, never authenticates
 * one.
 */
export const TokenShortId = Schema.String.check(
  Schema.isPattern(new RegExp(`^${patShortIdPattern}$`))
)
  .pipe(Schema.brand("TokenShortId"))
  .annotate({ identifier: "TokenShortId" });
export type TokenShortId = typeof TokenShortId.Type;

/** URL-safe high-entropy secret segment used only to construct an opaque bearer. */
export const TokenSecret = Schema.String.check(
  Schema.isPattern(new RegExp(`^${bearerSecretPattern}$`))
)
  .pipe(Schema.brand("TokenSecret"))
  .annotate({ identifier: "TokenSecret" });
export type TokenSecret = typeof TokenSecret.Type;

/**
 * The one-time opaque bearer presented by an agent. The `fin_` prefix and short
 * id make accidental disclosure recognizable; at least 32 URL-safe secret
 * characters supply authentication strength. Its secret and full encoding are
 * never persisted; storage retains only its hash and safe naming id.
 */
export const TokenBearer = Schema.String.check(
  Schema.isPattern(new RegExp(`^${bearerPrefix}${patShortIdPattern}_${bearerSecretPattern}$`))
)
  .pipe(Schema.brand("TokenBearer"))
  .annotate({ identifier: "TokenBearer" });
export type TokenBearer = typeof TokenBearer.Type;

type TokenBearerSegments = Readonly<{
  shortId: Readonly<TokenShortId>;
  secret: Readonly<TokenSecret>;
}>;

/** Builds the sole valid opaque bearer encoding from its validated segments. */
export const makeTokenBearer = ({
  shortId,
  secret,
}: TokenBearerSegments): Effect.Effect<TokenBearer> =>
  Effect.succeed(TokenBearer.make(`${bearerPrefix}${String(shortId)}_${String(secret)}`));

/** Reads the safe naming id embedded in a previously validated opaque bearer. */
export const getTokenShortId = (bearer: Readonly<TokenBearer>): Effect.Effect<TokenShortId> =>
  Effect.succeed(
    TokenShortId.make(bearer.slice(bearerPrefix.length, bearerPrefix.length + patShortIdLength))
  );

/** The rolling inactivity window after creation or the most recent use. */
export const PatIdleDuration = Duration.days(patIdleDays);
const patIdleDurationMilliseconds = Duration.toMillis(PatIdleDuration);

type TokenInstant = Readonly<{ epochMilliseconds: number }>;
type OptionalTokenInstant =
  | Readonly<{ _tag: "None" }>
  | Readonly<{ _tag: "Some"; value: TokenInstant }>;

const validPatTimes = Schema.makeFilter<
  Readonly<{
    lastUsedAt: OptionalTokenInstant;
    idleExpiresAt: TokenInstant;
    revokedAt: OptionalTokenInstant;
    createdAt: TokenInstant;
  }>
>((token) => {
  const createdAt = token.createdAt.epochMilliseconds;
  const lastUsedAt =
    token.lastUsedAt._tag === "Some" ? token.lastUsedAt.value.epochMilliseconds : createdAt;
  if (lastUsedAt < createdAt) {
    return {
      path: ["lastUsedAt"],
      issue: "PAT use cannot be before its creation time",
    };
  }
  const idleExpiresAt = token.idleExpiresAt.epochMilliseconds;
  if (idleExpiresAt !== lastUsedAt + patIdleDurationMilliseconds) {
    return {
      path: ["idleExpiresAt"],
      issue: "PAT idle expiry must be exactly 90 days after creation or last use",
    };
  }
  if (token.revokedAt._tag === "Some") {
    const revokedAt = token.revokedAt.value.epochMilliseconds;
    if (revokedAt < lastUsedAt) {
      return {
        path: ["revokedAt"],
        issue: "PAT revocation cannot be before its creation or last use",
      };
    }
  }
  return undefined;
});

const SharedTokenFields = {
  shortId: TokenShortId,
  lastUsedAt: Schema.Option(UtcTimestamp),
  revokedAt: Schema.Option(UtcTimestamp),
  createdAt: UtcTimestamp,
};

/**
 * A User-minted PAT grant. Its idle deadline advances on use and
 * disables the grant after 90 inactive days; revocation can disable it sooner.
 */
export const PAT = Schema.TaggedStruct("PAT", {
  ...SharedTokenFields,
  id: PATId,
  scopes: PatScopes,
  idleExpiresAt: UtcTimestamp,
})
  .check(validPatTimes)
  .annotate({ identifier: "PAT" });
export type PAT = typeof PAT.Type;

/**
 * The fixed capability set carried only by a HostedTurnToken: every canonical scope exactly once,
 * in any order. The internal grant does not inherit the User-authorized PatScope concept.
 */
export const HostedTurnScopes = Schema.UniqueArray(CanonicalScope)
  .check(Schema.isNonEmpty())
  .check(
    Schema.isMinLength(CanonicalScope.members.length, {
      expected: "every canonical scope exactly once",
    })
  )
  .annotate({ identifier: "HostedTurnScopes" });
export type HostedTurnScopes = typeof HostedTurnScopes.Type;

const validHostedTurnTokenTimes = Schema.makeFilter<
  Readonly<{
    lastUsedAt: OptionalTokenInstant;
    expiresAt: TokenInstant;
    revokedAt: OptionalTokenInstant;
    createdAt: TokenInstant;
  }>
>((token) => {
  const createdAt = token.createdAt.epochMilliseconds;
  const expiresAt = token.expiresAt.epochMilliseconds;
  const lastUsedAt =
    token.lastUsedAt._tag === "Some" ? token.lastUsedAt.value.epochMilliseconds : createdAt;
  if (expiresAt <= createdAt) {
    return { path: ["expiresAt"], issue: "HostedTurnToken expiry must follow creation" };
  }
  if (lastUsedAt < createdAt || lastUsedAt >= expiresAt) {
    return { path: ["lastUsedAt"], issue: "HostedTurnToken use must be inside its hard lifetime" };
  }
  if (token.revokedAt._tag === "Some" && token.revokedAt.value.epochMilliseconds < lastUsedAt) {
    return { path: ["revokedAt"], issue: "HostedTurnToken revocation cannot precede its use" };
  }
  return undefined;
});

/**
 * An internal all-scope HostedTurnToken created for one hosted Turn. Its absolute
 * expiry never renews, and the turn revokes it sooner during normal cleanup.
 */
export const HostedTurnToken = Schema.TaggedStruct("HostedTurnToken", {
  ...SharedTokenFields,
  id: HostedTurnTokenId,
  scopes: HostedTurnScopes,
  expiresAt: UtcTimestamp,
})
  .check(validHostedTurnTokenTimes)
  .annotate({ identifier: "HostedTurnToken" });
export type HostedTurnToken = typeof HostedTurnToken.Type;

/** Every persisted bearer grant accepted by canonical TokenAuthorization. */
export const TokenGrant = Schema.Union([PAT, HostedTurnToken]).annotate({
  identifier: "TokenGrant",
});
export type TokenGrant = typeof TokenGrant.Type;

/**
 * The authenticated bearer facts authorization needs after lookup.
 * This resolution adds the stable subject and renames the canonical token id to
 * distinguish it from the User id; it never leaves the process as a response.
 */
export const ResolvedToken = Schema.Struct({
  tokenId: Schema.Union([PATId, HostedTurnTokenId]),
  subjectUserId: UserId,
  scopes: Schema.UniqueArray(CanonicalScope).check(Schema.isNonEmpty()),
  // Bearer resolution has already recorded this use, so the timestamp is present.
  lastUsedAt: UtcTimestamp,
});
export type ResolvedToken = typeof ResolvedToken.Type;
