import { Duration, Effect, Schema, SchemaTransformation } from "effect";
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
export const PATScope = CanonicalCapability.annotate({ identifier: "PATScope" });
export type PATScope = typeof PATScope.Type;

/**
 * A non-empty set of PAT scopes. Duplicate entries are rejected so each
 * granted scope appears at most once; declaration order is retained.
 */
export const PATScopes = Schema.UniqueArray(PATScope).check(Schema.isNonEmpty());
export type PATScopes = typeof PATScopes.Type;

/** Maximum normalized length accepted for a PAT recipient label. */
export const recipientLabelLimit = 80;

/** Counts Unicode code points in recipient display metadata. */
export const countPATLabelCharacters = (label: string): number => Array.from(label).length;

const hasValidRecipientLabelLength = Schema.makeFilter<string>(
  (label) => countPATLabelCharacters(label) <= recipientLabelLimit,
  {
    expected: `a string with at most ${recipientLabelLimit} Unicode characters`,
    meta: { _tag: "isMaxLength", maxLength: recipientLabelLimit },
  }
);

/** Immutable display metadata naming the intended PAT recipient, not verified identity. */
export const PATRecipientLabel = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  hasValidRecipientLabelLength
)
  .pipe(Schema.brand("PATRecipientLabel"))
  .annotate({ identifier: "PATRecipientLabel" });
export type PATRecipientLabel = typeof PATRecipientLabel.Type;

/** Public codec that canonicalizes outer whitespace before validating recipient metadata. */
export const PATRecipientLabelInput = Schema.String.annotate({
  identifier: "PATRecipientLabelInput",
  description:
    "PAT recipient label whose surrounding whitespace is removed before enforcing 1 to 80 characters.",
}).pipe(
  Schema.decodeTo(
    PATRecipientLabel,
    SchemaTransformation.transform({
      decode: (label) => label.trim(),
      encode: (label) => label,
    })
  )
);
export type PATRecipientLabelInput = typeof PATRecipientLabelInput.Type;

/** Fixed lifetime presets, measured as exact 24-hour days from PAT issuance. */
const oneWeekInDays = 7;
const oneMonthInDays = 30;
const threeMonthsInDays = 90;
const oneYearInDays = 365;

/** Complete ordered set of lifetimes the User may select for a newly issued PAT. */
export const patLifetimeDayOptions = [
  oneWeekInDays,
  oneMonthInDays,
  threeMonthsInDays,
  oneYearInDays,
] as const;

/** Default selected lifetime for clients that have not made an explicit lifetime choice. */
export const defaultPATLifetimeDays = threeMonthsInDays;

/** Validates one supported fixed PAT lifetime measured in exact 24-hour days. */
export const PATLifetimeDays = Schema.Literals(patLifetimeDayOptions).annotate({
  identifier: "PATLifetimeDays",
});
export type PATLifetimeDays = typeof PATLifetimeDays.Type;

/** Exact recipient, capability set, and fixed lifetime confirmed for one manual PAT grant. */
export const ManualPATGrantInput = Schema.Struct({
  recipientLabel: PATRecipientLabelInput,
  scopes: PATScopes,
  lifetimeDays: PATLifetimeDays.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(defaultPATLifetimeDays))
  ),
  reviewExpiresAt: Schema.optionalKey(UtcTimestamp),
}).annotate({ identifier: "ManualPATGrantInput" });
export type ManualPATGrantInput = typeof ManualPATGrantInput.Type;

/** Browser-generated identity that makes one confirmed manual PAT issuance retry-safe. */
export const ManualPATRequestId = Schema.String.check(Schema.isUUID(4))
  .pipe(Schema.brand("ManualPATRequestId"))
  .annotate({
    identifier: "ManualPATRequestId",
  });
export type ManualPATRequestId = typeof ManualPATRequestId.Type;

/** Retry-safe canonical payload containing one reviewed grant. */
export const CreateManualPATPayload = Schema.Struct({
  requestId: ManualPATRequestId,
  grant: ManualPATGrantInput,
}).annotate({ identifier: "CreateManualPATPayload" });
export type CreateManualPATPayload = typeof CreateManualPATPayload.Type;

const bearerPrefix = "fin_";
const patShortIdLength = 8;
const patShortIdPattern = `[a-z0-9]{${patShortIdLength}}`;
const bearerSecretPattern = "[A-Za-z0-9_-]{32,}";
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

type TokenInstant = Readonly<{ epochMilliseconds: number }>;
type OptionalTokenInstant =
  | Readonly<{ _tag: "None" }>
  | Readonly<{ _tag: "Some"; value: TokenInstant }>;

/** Shared PAT lifecycle invariant for schemas that derive additional transport fields. */
export const PATLifecycleCheck = Schema.makeFilter<
  Readonly<{
    lifetimeDays: PATLifetimeDays;
    lastUsedAt: OptionalTokenInstant;
    expiresAt: TokenInstant;
    revokedAt: OptionalTokenInstant;
    createdAt: TokenInstant;
  }>
>((token) => {
  const createdAt = token.createdAt.epochMilliseconds;
  const expiresAt = token.expiresAt.epochMilliseconds;
  const expectedExpiresAt = createdAt + Duration.toMillis(Duration.days(token.lifetimeDays));
  if (expiresAt <= createdAt || expiresAt > expectedExpiresAt) {
    return {
      path: ["expiresAt"],
      issue: "PAT expiration must be positive and no later than its fixed lifetime after creation",
    };
  }
  const lastUsedAt =
    token.lastUsedAt._tag === "Some" ? token.lastUsedAt.value.epochMilliseconds : createdAt;
  if (lastUsedAt < createdAt || lastUsedAt >= expiresAt) {
    return {
      path: ["lastUsedAt"],
      issue: "PAT use must be at or after creation and before fixed expiration",
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
  lastUsedAt: Schema.OptionFromNullOr(UtcTimestamp),
  revokedAt: Schema.OptionFromNullOr(UtcTimestamp),
  createdAt: UtcTimestamp,
};

/**
 * A User-minted PAT grant. Its absolute expiration is fixed at issuance and cannot be renewed by
 * successful use; revocation can disable it sooner.
 */
export const PAT = Schema.TaggedStruct("PAT", {
  ...SharedTokenFields,
  id: PATId,
  recipientLabel: PATRecipientLabel,
  scopes: PATScopes,
  lifetimeDays: PATLifetimeDays,
  expiresAt: UtcTimestamp,
})
  .check(PATLifecycleCheck)
  .annotate({ identifier: "PAT" });
export type PAT = typeof PAT.Type;

/** One successful issuance; the bearer cannot be recovered after this immediate response. */
export const IssuedPAT = Schema.Struct({
  pat: PAT,
  bearer: TokenBearer,
}).annotate({ identifier: "IssuedPAT" });
export type IssuedPAT = typeof IssuedPAT.Type;

/** Every persisted bearer grant accepted by canonical TokenAuthorization. */
export const TokenGrant = PAT;
/** Decoded persisted bearer grant accepted by canonical TokenAuthorization. */
export type TokenGrant = PAT;

/** The authenticated PAT facts produced by bearer lookup at the HTTP edge. */
export const ResolvedToken = Schema.Struct({
  tokenId: PATId,
  subjectUserId: UserId,
  scopes: PATScopes,
  // Bearer resolution has already recorded this use, so the timestamp is present.
  lastUsedAt: UtcTimestamp,
});
export type ResolvedToken = typeof ResolvedToken.Type;
