import { DateTime, Effect, Option, Schema, SchemaTransformation } from "effect";
import { UtcTimestamp } from "~/core/_shared/time";
import {
  IssuedPAT,
  PATRecipientLabel,
  PATRecipientLabelInput,
  PATScopes,
  defaultPATLifetimeDays,
} from "./model";

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
const publicCodeAlphabet = "BCDFGHJKLMNPQRSTVWXZ";
const unbiasedBase20ByteLimit = 240;

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

/** Selects uniform public-code symbols by rejecting the biased random-byte tail. */
export const selectPATPairingPublicCodeSymbols = (input: {
  readonly bytes: ReadonlyArray<number>;
  readonly maximum: number;
}): string =>
  input.bytes
    .filter((byte) => byte < unbiasedBase20ByteLimit)
    .slice(0, input.maximum)
    .map((byte) => publicCodeAlphabet[byte % publicCodeAlphabet.length])
    .join("");

/** Fixed server-owned PATPairing lifetime. */
export const patPairingLifetime = "10 minutes" as const;

/** Minimum cadence advertised to a User-owned client polling a PATPairing. */
export const patPairingPollingIntervalSeconds = 5;

/** Computes the ten-minute deadline from the server-observed start instant. */
export const patPairingExpiry = (createdAt: DateTime.Utc): DateTime.Utc =>
  DateTime.addDuration(createdAt, patPairingLifetime);

/** Client-selected immutable request values accepted by direct PATPairing start. */
export const StartPATPairingPayload = Schema.Struct({
  recipientLabel: PATRecipientLabelInput,
  scopes: PATScopes,
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
  lifetimeDays: Schema.Literal(defaultPATLifetimeDays),
  patExpiresAt: UtcTimestamp,
  claimBy: UtcTimestamp,
}).annotate({ identifier: "PATPairingReview" });
export type PATPairingReview = typeof PATPairingReview.Type;

/** Approval accepts only the stable reviewed identity and exact server-provided expiration. */
export const ApprovePATPairingPayload = Schema.Struct({
  pairingId: PATPairingId,
  patExpiresAt: UtcTimestamp,
}).annotate({ identifier: "ApprovePATPairingPayload" });
export type ApprovePATPairingPayload = typeof ApprovePATPairingPayload.Type;

/** Safe browser success: the initiating client, not this browser, receives the bearer. */
export const ApprovedPATPairing = Schema.Struct({
  pairingId: PATPairingId,
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

type ClaimInput = Readonly<{
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

const millisecondsPerSecond = 1_000;
const pollingSlowdownIncrementSeconds = 5;
const maximumWrongProofAttempts = 32_767;

const isActivePairing = (lifecycle: PATPairingLifecycle): boolean =>
  lifecycle === "pending_approval" || lifecycle === "approved_awaiting_claim";
const expiryDecision = (lifecycle: PATPairingLifecycle): PATPairingClaimDecision =>
  lifecycle === "pending_approval" ? { _tag: "ExpireUnapproved" } : { _tag: "RevokeUnclaimed" };

const decidePATPairingClaimValue = (input: ClaimInput): PATPairingClaimDecision => {
  if (!isActivePairing(input.lifecycle)) return { _tag: "Invalid" };
  if (DateTime.isGreaterThanOrEqualTo(input.attemptedAt, input.expiresAt)) {
    return expiryDecision(input.lifecycle);
  }
  if (!input.proofMatches) {
    return {
      _tag: "WrongProof",
      wrongProofAttempts: Math.min(maximumWrongProofAttempts, input.wrongProofAttempts + 1),
    };
  }
  if (Option.isSome(input.lastAcceptedPollAt)) {
    const elapsedSeconds =
      (DateTime.toEpochMillis(input.attemptedAt) -
        DateTime.toEpochMillis(input.lastAcceptedPollAt.value)) /
      millisecondsPerSecond;
    if (elapsedSeconds < input.minimumPollIntervalSeconds) {
      const minimumPollIntervalSeconds =
        input.minimumPollIntervalSeconds + pollingSlowdownIncrementSeconds;
      return {
        _tag: "SlowDown",
        minimumPollIntervalSeconds,
        retryAfterSeconds: Math.max(1, Math.ceil(minimumPollIntervalSeconds - elapsedSeconds)),
      };
    }
  }
  return input.lifecycle === "approved_awaiting_claim"
    ? { _tag: "Claim" }
    : {
        _tag: "Pending",
        acceptedAt: input.attemptedAt,
        minimumPollIntervalSeconds: input.minimumPollIntervalSeconds,
      };
};

/** Decides one claim or poll after the shell has locked and verified one persisted candidate. */
export const decidePATPairingClaim = (input: ClaimInput): Effect.Effect<PATPairingClaimDecision> =>
  Effect.succeed(decidePATPairingClaimValue(input));
