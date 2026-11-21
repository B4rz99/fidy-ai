import { DateTime, Option } from "effect";
import {
  BrowserLoginPublicCode,
  type BrowserLoginPublicCodeSymbols,
  BrowserLoginRedemptionDecision,
  PendingBrowserLoginProofDecision,
  type PendingBrowserLoginProofInput,
  type RedemptionInput,
  browserLoginPairingLifetime,
  browserLoginPublicCodeAlphabet,
  maximumWrongVerifierAttempts,
} from "./contract";

const unbiasedBase20ByteLimit = 240;

const millisecondsPerSecond = 1_000;

const pollingSlowdownIncrementSeconds = 5;

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

export const formatPublicCode = (symbols: BrowserLoginPublicCodeSymbols): BrowserLoginPublicCode =>
  BrowserLoginPublicCode.make(`${symbols.slice(0, 4)}-${symbols.slice(4)}`);

export const decideApprovalTransition = (input: {
  readonly candidateOrdinal: bigint;
  readonly readyOrdinal: Option.Option<bigint>;
}): "bind" | "reject" =>
  Option.match(input.readyOrdinal, {
    onNone: () => "bind",
    onSome: (readyOrdinal) => (readyOrdinal < input.candidateOrdinal ? "bind" : "reject"),
  });

export const browserLoginPairingExpiry = (createdAt: DateTime.Utc): DateTime.Utc =>
  DateTime.addDuration(createdAt, browserLoginPairingLifetime);

const wrongPendingBrowserLoginProof = (
  wrongVerifierAttempts: number
): PendingBrowserLoginProofDecision => {
  const nextAttempts = nextWrongVerifierAttempts(wrongVerifierAttempts);

  return PendingBrowserLoginProofDecision.WrongVerifier({
    wrongVerifierAttempts: nextAttempts,
    lifecycle: nextAttempts === maximumWrongVerifierAttempts ? "invalidated" : "pending_approval",
  });
};

const decideUnexpiredPendingBrowserLoginProof = (
  input: PendingBrowserLoginProofInput
): PendingBrowserLoginProofDecision =>
  input.verifierMatches
    ? PendingBrowserLoginProofDecision.Accept()
    : wrongPendingBrowserLoginProof(input.wrongVerifierAttempts);

const decideLivePendingBrowserLoginProof = (
  input: PendingBrowserLoginProofInput
): PendingBrowserLoginProofDecision =>
  DateTime.isGreaterThanOrEqualTo(input.attemptedAt, input.expiresAt)
    ? PendingBrowserLoginProofDecision.Expired()
    : decideUnexpiredPendingBrowserLoginProof(input);

export const decidePendingBrowserLoginProof = (
  input: PendingBrowserLoginProofInput
): PendingBrowserLoginProofDecision =>
  input.lifecycle === "pending_approval"
    ? decideLivePendingBrowserLoginProof(input)
    : PendingBrowserLoginProofDecision.Invalid();

const nextWrongVerifierAttempts = (wrongVerifierAttempts: number): number =>
  Math.min(maximumWrongVerifierAttempts, wrongVerifierAttempts + 1);

const determineLifecycleAfterWrongVerifier = (
  activeLifecycle: "pending_approval" | "ready",
  wrongVerifierAttempts: number
): "pending_approval" | "ready" | "invalidated" =>
  wrongVerifierAttempts === maximumWrongVerifierAttempts ? "invalidated" : activeLifecycle;

export const decideBrowserLoginRedemption = (
  input: RedemptionInput
): BrowserLoginRedemptionDecision => {
  if (input.lifecycle !== "pending_approval" && input.lifecycle !== "ready") {
    return BrowserLoginRedemptionDecision.Invalid();
  }

  if (DateTime.isGreaterThanOrEqualTo(input.attemptedAt, input.expiresAt)) {
    return BrowserLoginRedemptionDecision.Expired();
  }

  if (!input.verifierMatches) {
    const wrongVerifierAttempts = nextWrongVerifierAttempts(input.wrongVerifierAttempts);

    return BrowserLoginRedemptionDecision.WrongVerifier({
      wrongVerifierAttempts,
      lifecycle: determineLifecycleAfterWrongVerifier(input.lifecycle, wrongVerifierAttempts),
    });
  }

  if (Option.isSome(input.lastAcceptedPollAt)) {
    const elapsedSeconds =
      (DateTime.toEpochMillis(input.attemptedAt) -
        DateTime.toEpochMillis(input.lastAcceptedPollAt.value)) /
      millisecondsPerSecond;

    if (elapsedSeconds < input.minimumPollIntervalSeconds) {
      const minimumPollIntervalSeconds =
        input.minimumPollIntervalSeconds + pollingSlowdownIncrementSeconds;

      return BrowserLoginRedemptionDecision.SlowDown({
        minimumPollIntervalSeconds,
        retryAfterSeconds: Math.max(1, Math.ceil(minimumPollIntervalSeconds - elapsedSeconds)),
      });
    }
  }

  return input.lifecycle === "ready"
    ? BrowserLoginRedemptionDecision.Consume()
    : BrowserLoginRedemptionDecision.Pending({
        acceptedAt: input.attemptedAt,
        minimumPollIntervalSeconds: input.minimumPollIntervalSeconds,
      });
};
