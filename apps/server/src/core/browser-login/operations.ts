import { DateTime, Option } from "effect";
import {
  BrowserLoginPublicCode,
  type BrowserLoginPublicCodeSymbols,
  type BrowserLoginRedemptionDecision,
  type PendingBrowserLoginProofDecision,
  type PendingBrowserLoginProofInput,
  type RedemptionInput,
  browserLoginPairingLifetime,
  browserLoginPublicCodeAlphabet,
  maximumWrongVerifierAttempts,
} from "./contract";

const unbiasedBase20ByteLimit = 240;
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
