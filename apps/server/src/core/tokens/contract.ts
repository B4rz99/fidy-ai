import { type DateTime, Duration, Effect, type Option, Schema, SchemaTransformation } from "effect";
import { UserId } from "~/core/identity/contract";
import { CanonicalCapability } from "~/core/canonical-operations/contract";
import { UtcTimestamp } from "~/core/_shared/time";

/** Stable identity of one User-authorized Personal Access Token grant. */
export const PATId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("PATId"))
  .annotate({ identifier: "PATId" });
export type PATId = typeof PATId.Type;

/**
 * One access capability a User may grant to a PAT, named in the public token vocabulary. Scopes are
 * independent: a caller receives only the canonical operations whose declared scope appears in its
 * PAT. The literal set is the credential-neutral capability set, so a capability cannot become
 * grantable here without also being enforceable there.
 */
export const PATScope = CanonicalCapability.annotate({
  identifier: "PATScope",
});
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
    toJsonSchema: () => ({ maxLength: recipientLabelLimit }),
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
  reviewExpiresAt: UtcTimestamp,
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

/** Public PAT namespace; the prefix identifies its format and conveys no authority. */
export const patBearerPrefix = "fin_";
/** Number of public naming characters embedded in every opaque PAT bearer. */
export const patShortIdLength = 8;
const patShortIdPattern = `[a-z0-9]{${patShortIdLength}}`;
const bearerSecretPattern = "[A-Za-z0-9_-]{32,}";
/** Human-readable notation for the one opaque bearer encoding. */
export const TokenBearerFormat = `${patBearerPrefix}<short-id>_<secret>`;

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
  Schema.isPattern(new RegExp(`^${patBearerPrefix}${patShortIdPattern}_${bearerSecretPattern}$`))
)
  .pipe(Schema.brand("TokenBearer"))
  .annotate({ identifier: "TokenBearer" });
export type TokenBearer = typeof TokenBearer.Type;

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

/**
 * Safe public metadata for one currently usable PAT. Presence in a management listing establishes
 * active lifecycle, so terminal state, stable identity, and all credential material stay absent.
 */
export const ActivePATMetadata = Schema.Struct({
  shortId: TokenShortId,
  recipientLabel: PATRecipientLabel,
  scopes: PATScopes,
  createdAt: UtcTimestamp,
  lastUsedAt: Schema.OptionFromNullOr(UtcTimestamp),
  expiresAt: UtcTimestamp,
}).annotate({ identifier: "ActivePATMetadata" });
export type ActivePATMetadata = typeof ActivePATMetadata.Type;

/** Bounded product result containing only the User's currently active PATs. */
export const ActivePATList = Schema.Struct({
  pats: Schema.Array(ActivePATMetadata),
}).annotate({ identifier: "ActivePATList" });
export type ActivePATList = typeof ActivePATList.Type;

/** One safe acknowledgement of a selected PAT revocation. */
export const RevokedPAT = Schema.Struct({ shortId: TokenShortId }).annotate({
  identifier: "RevokedPAT",
});
export type RevokedPAT = typeof RevokedPAT.Type;

/** Bounded acknowledgement for an all-PAT revocation. */
export const RevokedPATCount = Schema.Struct({
  revokedCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({
  identifier: "RevokedPATCount",
});
export type RevokedPATCount = typeof RevokedPATCount.Type;

/**
 * One successful issuance; the bearer cannot be recovered after this immediate response. The
 * bearer is a redacted value everywhere it is held as a value, and only its encoded JSON form is
 * the raw opaque bearer that constitutes the one-time disclosure.
 */
export const IssuedPAT = Schema.Struct({
  pat: PAT,
  bearer: Schema.RedactedFromValue(TokenBearer),
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

/** Stable non-secret identity of one PATPairing. */
export const PATPairingId = Schema.String.check(Schema.isUUID(4))
  .pipe(Schema.brand("PATPairingId"))
  .annotate({ identifier: "PATPairingId" });
export type PATPairingId = typeof PATPairingId.Type;

/** High-entropy claim proof disclosed once to the initiating User-owned client. */
export const PATPairingDeviceCode = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u))
  .pipe(Schema.brand("PATPairingDeviceCode"))
  .annotate({ identifier: "PATPairingDeviceCode" });
export type PATPairingDeviceCode = typeof PATPairingDeviceCode.Type;

const publicCodePattern = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/u;
const publicCodeSymbolsPattern = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/u;

/** Public human-entered request identity; possession grants neither approval nor claim authority. */
export const PATPairingPublicCode = Schema.String.check(Schema.isPattern(publicCodePattern))
  .pipe(Schema.brand("PATPairingPublicCode"))
  .annotate({ identifier: "PATPairingPublicCode" });
export type PATPairingPublicCode = typeof PATPairingPublicCode.Type;

const normalizePublicCode = (input: string): string => {
  const upper = input.replace(/^[\t\n\r ]+|[\t\n\r ]+$/gu, "").toUpperCase();
  if (publicCodePattern.test(upper)) return upper;
  return publicCodeSymbolsPattern.test(upper) ? `${upper.slice(0, 4)}-${upper.slice(4)}` : upper;
};

/** Public decoder with narrow ASCII presentation normalization and canonical encoding. */
export const PATPairingPublicCodeInput = Schema.String.pipe(
  Schema.decodeTo(
    PATPairingPublicCode,
    SchemaTransformation.transform({
      decode: normalizePublicCode,
      encode: (code) => code,
    })
  )
);

/** Fixed server-owned PATPairing lifetime. */
export const patPairingLifetime = "10 minutes" as const;

/** Minimum cadence advertised to a User-owned client polling a PATPairing. */
export const patPairingPollingIntervalSeconds = 5;

/** Client-selected immutable request values accepted by direct PATPairing start. */
export const StartPATPairingPayload = Schema.Struct({
  recipientLabel: PATRecipientLabelInput,
  scopes: PATScopes,
  lifetimeDays: PATLifetimeDays.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(defaultPATLifetimeDays))
  ),
}).annotate({ identifier: "StartPATPairingPayload" });
export type StartPATPairingPayload = typeof StartPATPairingPayload.Type;

/** Secret-bearing start response returned only over the direct no-store API. */
export const StartedPATPairing = Schema.Struct({
  pairingId: PATPairingId,
  privateDeviceCode: Schema.RedactedFromValue(PATPairingDeviceCode),
  publicCode: PATPairingPublicCode,
  expiresAt: UtcTimestamp,
  pollingIntervalSeconds: Schema.Literal(patPairingPollingIntervalSeconds),
}).annotate({ identifier: "StartedPATPairing" });
export type StartedPATPairing = typeof StartedPATPairing.Type;

/** Correct proof before approval receives only bounded polling metadata. */
export const PendingPATPairingClaim = Schema.Struct({
  status: Schema.Literal("pending_approval"),
  expiresAt: UtcTimestamp,
  pollingIntervalSeconds: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(patPairingPollingIntervalSeconds)
  ),
}).annotate({ identifier: "PendingPATPairingClaim", httpApiStatus: 202 });
export type PendingPATPairingClaim = typeof PendingPATPairingClaim.Type;

/** One successful claim discloses the paired PAT bearer exactly once. */
export const ClaimedPATPairing = IssuedPAT.annotate({
  identifier: "ClaimedPATPairing",
  httpApiStatus: 200,
});

/** Safe immutable snapshot reviewed in a fresh WebSession. */
export const PATPairingReview = Schema.Struct({
  pairingId: PATPairingId,
  recipientLabel: PATRecipientLabel,
  scopes: PATScopes,
  lifetimeDays: PATLifetimeDays,
  claimBy: UtcTimestamp,
}).annotate({ identifier: "PATPairingReview" });
export type PATPairingReview = typeof PATPairingReview.Type;

/** Approval binds the reviewed pairing; its fixed lifetime begins at approval. */
export const ApprovePATPairingPayload = Schema.Struct({
  pairingId: PATPairingId,
}).annotate({ identifier: "ApprovePATPairingPayload" });
export type ApprovePATPairingPayload = typeof ApprovePATPairingPayload.Type;

/** Safe browser success: the initiating client, not this browser, receives the bearer. */
export const ApprovedPATPairing = Schema.Struct({
  pairingId: PATPairingId,
  patExpiresAt: UtcTimestamp,
  claimBy: UtcTimestamp,
}).annotate({ identifier: "ApprovedPATPairing" });
export type ApprovedPATPairing = typeof ApprovedPATPairing.Type;

/** The one authoritative persisted PATPairing lifecycle. */
export const PATPairingLifecycle = Schema.Literals([
  "pending_approval",
  "approved_awaiting_claim",
  "claimed",
  "expired_unapproved",
  "revoked_unclaimed",
]);
export type PATPairingLifecycle = typeof PATPairingLifecycle.Type;

/** Persisted pairing state and verified proof at one server-observed attempt instant. */
export type PATPairingClaimInput = Readonly<{
  lifecycle: PATPairingLifecycle;
  proofMatches: boolean;
  wrongProofAttempts: number;
  minimumPollIntervalSeconds: number;
  lastAcceptedPollAt: Option.Option<DateTime.Utc>;
  expiresAt: DateTime.Utc;
  attemptedAt: DateTime.Utc;
}>;

/** Closed pure decisions interpreted atomically by the proof-bearing claim shell. */
export type PATPairingClaimDecision =
  | Readonly<{
      _tag: "Pending";
      acceptedAt: DateTime.Utc;
      minimumPollIntervalSeconds: number;
    }>
  | Readonly<{ _tag: "Claim" }>
  | Readonly<{ _tag: "WrongProof"; wrongProofAttempts: number }>
  | Readonly<{
      _tag: "SlowDown";
      minimumPollIntervalSeconds: number;
      retryAfterSeconds: number;
    }>
  | Readonly<{ _tag: "ExpireUnapproved" }>
  | Readonly<{ _tag: "RevokeUnclaimed" }>
  | Readonly<{ _tag: "Invalid" }>;
