import { DateTime, Option, Schema, SchemaTransformation } from "effect";
/** Minimum cadence advertised to browsers polling a pairing challenge. */
export const browserLoginPollingIntervalSeconds = 5;

/** Unambiguous base-20 alphabet used by every public-code representation. */
export const browserLoginPublicCodeAlphabet = "BCDFGHJKLMNPQRSTVWXZ" as const;

const browserLoginPublicCodePattern = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/u;
const browserLoginPublicCodeSymbolsPattern = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/u;

/** Public, human-entered code. Its possession never establishes a browser session. */
export const BrowserLoginPublicCode = Schema.String.check(
  Schema.isPattern(browserLoginPublicCodePattern)
)
  .pipe(Schema.brand("BrowserLoginPublicCode"))
  .annotate({ identifier: "BrowserLoginPublicCode" });
export type BrowserLoginPublicCode = typeof BrowserLoginPublicCode.Type;

/** Fixed lifetime applied by the server when it creates an unbound challenge. */
export const browserLoginPairingLifetime = "10 minutes" as const;

const unbiasedBase20ByteLimit = 240;
/** Shared terminal threshold for wrong private-verifier attempts against one pairing. */
export const maximumWrongVerifierAttempts = 5;
const millisecondsPerSecond = 1_000;
const pollingSlowdownIncrementSeconds = 5;

/** Selects at most `maximum` uniform code symbols, rejecting biased random-byte values. */
export const selectPublicCodeSymbols = (
  input: Readonly<{ readonly bytes: ReadonlyArray<number>; readonly maximum: number }>
): string => {
  let accepted = "";
  for (const byte of input.bytes) {
    if (byte >= unbiasedBase20ByteLimit) continue;
    accepted += browserLoginPublicCodeAlphabet[byte % browserLoginPublicCodeAlphabet.length];
    if (accepted.length === input.maximum) break;
  }
  return accepted;
};

/** Eight validated symbols sampled from the public-code alphabet before display formatting. */
export const BrowserLoginPublicCodeSymbols = Schema.String.check(
  Schema.isPattern(browserLoginPublicCodeSymbolsPattern)
).pipe(Schema.brand("BrowserLoginPublicCodeSymbols"));
export type BrowserLoginPublicCodeSymbols = typeof BrowserLoginPublicCodeSymbols.Type;

/** Formats eight validated base-20 symbols into the only canonical public spelling. */
export const formatPublicCode = (symbols: BrowserLoginPublicCodeSymbols): BrowserLoginPublicCode =>
  BrowserLoginPublicCode.make(`${symbols.slice(0, 4)}-${symbols.slice(4)}`);

/** Decides whether a pending challenge may replace the User's current Ready challenge. */
export const decideApprovalTransition = (input: {
  readonly candidateOrdinal: bigint;
  readonly readyOrdinal: Option.Option<bigint>;
}): "bind" | "reject" =>
  Option.match(input.readyOrdinal, {
    onNone: () => "bind",
    onSome: (readyOrdinal) => (readyOrdinal < input.candidateOrdinal ? "bind" : "reject"),
  });

/** Expiry is fixed by the challenge creation instant, not caller input. */
export const browserLoginPairingExpiry = (createdAt: DateTime.Utc): DateTime.Utc =>
  DateTime.addDuration(createdAt, browserLoginPairingLifetime);

/** Persisted lifecycle values against which redemption decisions are total. */
export const BrowserLoginPairingLifecycle = Schema.Literals([
  "pending_approval",
  "ready",
  "expired",
  "superseded",
  "consumed",
  "invalidated",
]);
export type BrowserLoginPairingLifecycle = typeof BrowserLoginPairingLifecycle.Type;

type RedemptionInput = Readonly<{
  lifecycle: BrowserLoginPairingLifecycle;
  verifierMatches: boolean;
  wrongVerifierAttempts: number;
  minimumPollIntervalSeconds: number;
  lastAcceptedPollAt: Option.Option<DateTime.Utc>;
  expiresAt: DateTime.Utc;
  attemptedAt: DateTime.Utc;
}>;

/** Closed result set consumed by the transactional redemption shell. */
export type BrowserLoginRedemptionDecision =
  | Readonly<{
      _tag: "Pending";
      acceptedAt: DateTime.Utc;
      minimumPollIntervalSeconds: number;
    }>
  | Readonly<{ _tag: "Consume" }>
  | Readonly<{
      _tag: "WrongVerifier";
      wrongVerifierAttempts: number;
      lifecycle: "pending_approval" | "ready" | "invalidated";
    }>
  | Readonly<{
      _tag: "SlowDown";
      minimumPollIntervalSeconds: number;
      retryAfterSeconds: number;
    }>
  | Readonly<{ _tag: "Expired" }>
  | Readonly<{ _tag: "Invalid" }>;

/** Closed outcome for a proof check that deliberately excludes polling cadence and redemption. */
export type PendingBrowserLoginProofDecision =
  | Readonly<{ _tag: "Accept" }>
  | Readonly<{ _tag: "Invalid" }>
  | Readonly<{ _tag: "Expired" }>
  | Readonly<{
      _tag: "WrongVerifier";
      wrongVerifierAttempts: number;
      lifecycle: "pending_approval" | "invalidated";
    }>;

type PendingBrowserLoginProofInput = Readonly<{
  lifecycle: BrowserLoginPairingLifecycle;
  verifierMatches: boolean;
  wrongVerifierAttempts: number;
  expiresAt: DateTime.Utc;
  attemptedAt: DateTime.Utc;
}>;

const wrongPendingBrowserLoginProof = (
  wrongVerifierAttempts: number
): PendingBrowserLoginProofDecision => {
  const nextAttempts = nextWrongVerifierAttempts(wrongVerifierAttempts);
  return {
    _tag: "WrongVerifier",
    wrongVerifierAttempts: nextAttempts,
    lifecycle: nextAttempts === maximumWrongVerifierAttempts ? "invalidated" : "pending_approval",
  };
};

const decideUnexpiredPendingBrowserLoginProof = (
  input: PendingBrowserLoginProofInput
): PendingBrowserLoginProofDecision =>
  input.verifierMatches
    ? { _tag: "Accept" }
    : wrongPendingBrowserLoginProof(input.wrongVerifierAttempts);

const decideLivePendingBrowserLoginProof = (
  input: PendingBrowserLoginProofInput
): PendingBrowserLoginProofDecision =>
  DateTime.isGreaterThanOrEqualTo(input.attemptedAt, input.expiresAt)
    ? { _tag: "Expired" }
    : decideUnexpiredPendingBrowserLoginProof(input);

/** Decides a non-polling proof check against one locked pending pairing. */
export const decidePendingBrowserLoginProof = (
  input: PendingBrowserLoginProofInput
): PendingBrowserLoginProofDecision =>
  input.lifecycle === "pending_approval"
    ? decideLivePendingBrowserLoginProof(input)
    : { _tag: "Invalid" };

const nextWrongVerifierAttempts = (wrongVerifierAttempts: number): number =>
  Math.min(maximumWrongVerifierAttempts, wrongVerifierAttempts + 1);

const determineLifecycleAfterWrongVerifier = (
  activeLifecycle: "pending_approval" | "ready",
  wrongVerifierAttempts: number
): "pending_approval" | "ready" | "invalidated" =>
  wrongVerifierAttempts === maximumWrongVerifierAttempts ? "invalidated" : activeLifecycle;

/**
 * Decides one proof-bearing poll against a locked candidate. Unknown candidates take the generic
 * shell path after a dummy digest comparison; this rule handles only a real persisted pairing.
 */
export const decideBrowserLoginRedemption = (
  input: RedemptionInput
): BrowserLoginRedemptionDecision => {
  if (input.lifecycle !== "pending_approval" && input.lifecycle !== "ready") {
    return { _tag: "Invalid" };
  }
  if (DateTime.isGreaterThanOrEqualTo(input.attemptedAt, input.expiresAt)) {
    return { _tag: "Expired" };
  }
  if (!input.verifierMatches) {
    const wrongVerifierAttempts = nextWrongVerifierAttempts(input.wrongVerifierAttempts);
    return {
      _tag: "WrongVerifier",
      wrongVerifierAttempts,
      lifecycle: determineLifecycleAfterWrongVerifier(input.lifecycle, wrongVerifierAttempts),
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

  return input.lifecycle === "ready"
    ? { _tag: "Consume" }
    : {
        _tag: "Pending",
        acceptedAt: input.attemptedAt,
        minimumPollIntervalSeconds: input.minimumPollIntervalSeconds,
      };
};

const normalizePublicCodeText = (input: string): string => {
  const upper = input.replace(/^[\t\n\r ]+|[\t\n\r ]+$/gu, "").toUpperCase();
  if (browserLoginPublicCodePattern.test(upper)) return upper;
  return browserLoginPublicCodeSymbolsPattern.test(upper)
    ? `${upper.slice(0, 4)}-${upper.slice(4)}`
    : upper;
};

/** Public decoder with narrow ASCII presentation normalization and canonical encoding. */
export const BrowserLoginPublicCodeInput = Schema.String.pipe(
  Schema.decodeTo(
    BrowserLoginPublicCode,
    SchemaTransformation.transform({
      decode: normalizePublicCodeText,
      encode: (code) => code,
    })
  )
);
