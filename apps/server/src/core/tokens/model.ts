import { Duration, Effect, Schema } from "effect";
import { PATId } from "./reference";
import { UserId } from "~/core/identity/reference";
import { CanonicalCapability } from "~/core/_shared/canonical-capability";
import { UtcTimestamp } from "~/core/_shared/time";

/**
 * One access capability a User may grant to a PAT, named in the public token vocabulary. Scopes are
 * independent: a caller receives only the canonical operations whose declared scope appears in its
 * PAT. The literal set is the credential-neutral capability set, so a capability cannot become
 * grantable here without also being enforceable there.
 */
export const PatScope = CanonicalCapability.annotate({ identifier: "PatScope" });
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

/** Every persisted bearer grant accepted by canonical TokenAuthorization. */
export const TokenGrant = PAT;
/** Decoded persisted bearer grant accepted by canonical TokenAuthorization. */
export type TokenGrant = PAT;

/** The authenticated PAT facts produced by bearer lookup at the HTTP edge. */
export const ResolvedToken = Schema.Struct({
  tokenId: PATId,
  subjectUserId: UserId,
  scopes: PatScopes,
  // Bearer resolution has already recorded this use, so the timestamp is present.
  lastUsedAt: UtcTimestamp,
});
export type ResolvedToken = typeof ResolvedToken.Type;
