import {
  Data,
  type DateTime,
  Duration,
  Effect,
  Option,
  Schema,
  SchemaTransformation,
} from "effect";
import { UserId } from "~/core/identity/contract";
import { CanonicalCapability } from "~/core/canonical-operations/contract";
import { UtcTimestamp } from "~/core/_shared/time";

export const PATId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("PATId"))
  .annotate({ identifier: "PATId" });

export type PATId = typeof PATId.Type;

export const PATScope = CanonicalCapability.annotate({
  identifier: "PATScope",
});

export type PATScope = typeof PATScope.Type;

export const PATScopes = Schema.UniqueArray(PATScope).check(Schema.isNonEmpty());

export type PATScopes = typeof PATScopes.Type;

export const recipientLabelLimit = 80;

export const countPATLabelCharacters = (label: string): number => Array.from(label).length;

const hasValidRecipientLabelLength = Schema.makeFilter<string>(
  (label) => countPATLabelCharacters(label) <= recipientLabelLimit,
  {
    expected: `a string with at most ${recipientLabelLimit} Unicode characters`,
    toJsonSchema: () => ({ maxLength: recipientLabelLimit }),
  }
);

export const PATRecipientLabel = Schema.NonEmptyString.check(
  Schema.isTrimmed(),
  hasValidRecipientLabelLength
)
  .pipe(Schema.brand("PATRecipientLabel"))
  .annotate({ identifier: "PATRecipientLabel" });

export type PATRecipientLabel = typeof PATRecipientLabel.Type;

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

const oneWeekInDays = 7;

const oneMonthInDays = 30;

const threeMonthsInDays = 90;

const oneYearInDays = 365;

export const patLifetimeDayOptions = [
  oneWeekInDays,
  oneMonthInDays,
  threeMonthsInDays,
  oneYearInDays,
] as const;

export const defaultPATLifetimeDays = threeMonthsInDays;

export const PATLifetimeDays = Schema.Literals(patLifetimeDayOptions).annotate({
  identifier: "PATLifetimeDays",
});

export type PATLifetimeDays = typeof PATLifetimeDays.Type;

export const ManualPATGrantInput = Schema.Struct({
  recipientLabel: PATRecipientLabelInput,
  scopes: PATScopes,
  lifetimeDays: PATLifetimeDays.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(defaultPATLifetimeDays))
  ),
  reviewExpiresAt: UtcTimestamp,
}).annotate({ identifier: "ManualPATGrantInput" });

export type ManualPATGrantInput = typeof ManualPATGrantInput.Type;

export const ManualPATRequestId = Schema.String.check(Schema.isUUID(4))
  .pipe(Schema.brand("ManualPATRequestId"))
  .annotate({
    identifier: "ManualPATRequestId",
  });

export type ManualPATRequestId = typeof ManualPATRequestId.Type;

export const CreateManualPATPayload = Schema.Struct({
  requestId: ManualPATRequestId,
  grant: ManualPATGrantInput,
}).annotate({ identifier: "CreateManualPATPayload" });

export type CreateManualPATPayload = typeof CreateManualPATPayload.Type;

export const patBearerPrefix = "fin_";

export const patShortIdLength = 8;

const patShortIdPattern = `[a-z0-9]{${patShortIdLength}}`;

const bearerSecretPattern = "[A-Za-z0-9_-]{32,}";

export const TokenBearerFormat = `${patBearerPrefix}<short-id>_<secret>`;

export const bearerSecretBytes = 32;

export const TokenShortId = Schema.String.check(
  Schema.isPattern(new RegExp(`^${patShortIdPattern}$`, "u"))
)
  .pipe(Schema.brand("TokenShortId"))
  .annotate({ identifier: "TokenShortId" });

export type TokenShortId = typeof TokenShortId.Type;

export const TokenSecret = Schema.String.check(
  Schema.isPattern(new RegExp(`^${bearerSecretPattern}$`, "u"))
)
  .pipe(Schema.brand("TokenSecret"))
  .annotate({ identifier: "TokenSecret" });

export type TokenSecret = typeof TokenSecret.Type;

export const TokenBearer = Schema.String.check(
  Schema.isPattern(
    new RegExp(`^${patBearerPrefix}${patShortIdPattern}_${bearerSecretPattern}$`, "u")
  )
)
  .pipe(Schema.brand("TokenBearer"))
  .annotate({ identifier: "TokenBearer" });

export type TokenBearer = typeof TokenBearer.Type;

type TokenInstant = Readonly<{ epochMilliseconds: number }>;

type OptionalTokenInstant = Option.Option<TokenInstant>;

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

  const lastUsedAt = Option.match(token.lastUsedAt, {
    onNone: () => createdAt,
    onSome: (instant) => instant.epochMilliseconds,
  });

  if (lastUsedAt < createdAt || lastUsedAt >= expiresAt) {
    return {
      path: ["lastUsedAt"],
      issue: "PAT use must be at or after creation and before fixed expiration",
    };
  }

  if (Option.isSome(token.revokedAt)) {
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

export const ActivePATMetadata = Schema.Struct({
  shortId: TokenShortId,
  recipientLabel: PATRecipientLabel,
  scopes: PATScopes,
  createdAt: UtcTimestamp,
  lastUsedAt: Schema.OptionFromNullOr(UtcTimestamp),
  expiresAt: UtcTimestamp,
}).annotate({ identifier: "ActivePATMetadata" });

export type ActivePATMetadata = typeof ActivePATMetadata.Type;

export const ActivePATList = Schema.Struct({
  pats: Schema.Array(ActivePATMetadata),
}).annotate({ identifier: "ActivePATList" });

export type ActivePATList = typeof ActivePATList.Type;

export const RevokedPAT = Schema.Struct({ shortId: TokenShortId }).annotate({
  identifier: "RevokedPAT",
});

export type RevokedPAT = typeof RevokedPAT.Type;

export const RevokedPATCount = Schema.Struct({
  revokedCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
}).annotate({
  identifier: "RevokedPATCount",
});

export type RevokedPATCount = typeof RevokedPATCount.Type;

export const IssuedPAT = Schema.Struct({
  pat: PAT,
  bearer: Schema.RedactedFromValue(TokenBearer),
}).annotate({ identifier: "IssuedPAT" });

export type IssuedPAT = typeof IssuedPAT.Type;

export const TokenGrant = PAT;

export type TokenGrant = PAT;

export const ResolvedToken = Schema.Struct({
  tokenId: PATId,
  subjectUserId: UserId,
  scopes: PATScopes,
  lastUsedAt: UtcTimestamp,
});

export type ResolvedToken = typeof ResolvedToken.Type;

export const PATPairingId = Schema.String.check(Schema.isUUID(4))
  .pipe(Schema.brand("PATPairingId"))
  .annotate({ identifier: "PATPairingId" });

export type PATPairingId = typeof PATPairingId.Type;

export const PATPairingDeviceCode = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{43}$/u))
  .pipe(Schema.brand("PATPairingDeviceCode"))
  .annotate({ identifier: "PATPairingDeviceCode" });

export type PATPairingDeviceCode = typeof PATPairingDeviceCode.Type;

const publicCodePattern = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/u;

const publicCodeSymbolsPattern = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/u;

export const PATPairingPublicCode = Schema.String.check(Schema.isPattern(publicCodePattern))
  .pipe(Schema.brand("PATPairingPublicCode"))
  .annotate({ identifier: "PATPairingPublicCode" });

export type PATPairingPublicCode = typeof PATPairingPublicCode.Type;

const normalizePublicCode = (input: string): string => {
  const upper = input.replace(/^[\t\n\r ]+|[\t\n\r ]+$/gu, "").toUpperCase();

  return publicCodeSymbolsPattern.test(upper) ? `${upper.slice(0, 4)}-${upper.slice(4)}` : upper;
};

export const PATPairingPublicCodeInput = Schema.String.pipe(
  Schema.decodeTo(
    PATPairingPublicCode,
    SchemaTransformation.transform({
      decode: normalizePublicCode,
      encode: (code) => code,
    })
  )
);

export const patPairingLifetime = "10 minutes" as const;

export const patPairingPollingIntervalSeconds = 5;

export const StartPATPairingPayload = Schema.Struct({
  recipientLabel: PATRecipientLabelInput,
  scopes: PATScopes,
  lifetimeDays: PATLifetimeDays.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(defaultPATLifetimeDays))
  ),
}).annotate({ identifier: "StartPATPairingPayload" });

export type StartPATPairingPayload = typeof StartPATPairingPayload.Type;

export const StartedPATPairing = Schema.Struct({
  pairingId: PATPairingId,
  privateDeviceCode: Schema.RedactedFromValue(PATPairingDeviceCode),
  publicCode: PATPairingPublicCode,
  expiresAt: UtcTimestamp,
  pollingIntervalSeconds: Schema.Literal(patPairingPollingIntervalSeconds),
}).annotate({ identifier: "StartedPATPairing" });

export type StartedPATPairing = typeof StartedPATPairing.Type;

export const PendingPATPairingClaim = Schema.Struct({
  status: Schema.Literal("pending_approval"),
  expiresAt: UtcTimestamp,
  pollingIntervalSeconds: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(patPairingPollingIntervalSeconds)
  ),
}).annotate({ identifier: "PendingPATPairingClaim", httpApiStatus: 202 });

export type PendingPATPairingClaim = typeof PendingPATPairingClaim.Type;

export const ClaimedPATPairing = IssuedPAT.annotate({
  identifier: "ClaimedPATPairing",
  httpApiStatus: 200,
});

export const PATPairingReview = Schema.Struct({
  pairingId: PATPairingId,
  recipientLabel: PATRecipientLabel,
  scopes: PATScopes,
  lifetimeDays: PATLifetimeDays,
  claimBy: UtcTimestamp,
}).annotate({ identifier: "PATPairingReview" });

export type PATPairingReview = typeof PATPairingReview.Type;

export const ApprovePATPairingPayload = Schema.Struct({
  pairingId: PATPairingId,
}).annotate({ identifier: "ApprovePATPairingPayload" });

export type ApprovePATPairingPayload = typeof ApprovePATPairingPayload.Type;

export const ApprovedPATPairing = Schema.Struct({
  pairingId: PATPairingId,
  patExpiresAt: UtcTimestamp,
  claimBy: UtcTimestamp,
}).annotate({ identifier: "ApprovedPATPairing" });

export type ApprovedPATPairing = typeof ApprovedPATPairing.Type;

export const PATPairingLifecycle = Schema.Literals([
  "pending_approval",
  "approved_awaiting_claim",
  "claimed",
  "expired_unapproved",
  "revoked_unclaimed",
]);

export type PATPairingLifecycle = typeof PATPairingLifecycle.Type;

export type PATPairingClaimInput = Readonly<{
  lifecycle: PATPairingLifecycle;
  proofMatches: boolean;
  wrongProofAttempts: number;
  minimumPollIntervalSeconds: number;
  lastAcceptedPollAt: Option.Option<DateTime.Utc>;
  expiresAt: DateTime.Utc;
  attemptedAt: DateTime.Utc;
}>;

export type PATPairingClaimDecision = Data.TaggedEnum<{
  Pending: { readonly acceptedAt: DateTime.Utc; readonly minimumPollIntervalSeconds: number };
  Claim: {};
  WrongProof: { readonly wrongProofAttempts: number };
  SlowDown: { readonly minimumPollIntervalSeconds: number; readonly retryAfterSeconds: number };
  ExpireUnapproved: {};
  RevokeUnclaimed: {};
  Invalid: {};
}>;

export const PATPairingClaimDecision = Data.taggedEnum<PATPairingClaimDecision>();

export const PATActivityMetadata = Schema.Struct({
  ...ActivePATMetadata.fields,
  revokedAt: Schema.OptionFromNullOr(UtcTimestamp),
}).annotate({ identifier: "PATActivityMetadata" });

export type PATActivityMetadata = typeof PATActivityMetadata.Type;
