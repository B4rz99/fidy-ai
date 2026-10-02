import { DateTime, Effect, Option } from "effect";
import {
  type EmailReplacementRequestDecision,
  type ProofAttemptDecision,
  type ProofAttemptInput,
  maximumEmailDeliveryGenerations,
} from "./contract";

/** Uniform 32-symbol alphabet without visually ambiguous I, O, 0, or 1. */
export const emailCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" as const;
const maximumWrongProofAttempts = 5;

/** Returns the exact end of a 24-hour bounded email-control workflow. */
export const emailWorkflowExpiry = (startedAt: DateTime.Utc): DateTime.Utc =>
  DateTime.add(startedAt, { hours: 24 });

/** Returns the exact end of a fresh proof's ten-minute half-open validity interval. */
export const proofExpiry = (generatedAt: DateTime.Utc): DateTime.Utc =>
  DateTime.add(generatedAt, { minutes: 10 });

/** Returns the earliest instant at which the User may explicitly request another delivery. */
export const resendAvailability = (submittedAt: DateTime.Utc): DateTime.Utc =>
  DateTime.add(submittedAt, { seconds: 60 });

/** Maps random bytes to unbiased code symbols; 256 is exactly divisible by the alphabet size. */
export const selectEmailCodeSymbols = (input: {
  readonly bytes: ArrayLike<number>;
  readonly maximum: number;
}): string =>
  Array.from(input.bytes)
    .slice(0, input.maximum)
    .map((byte) => emailCodeAlphabet[byte % emailCodeAlphabet.length])
    .join("");

/** Formats unambiguous symbols into fixed groups without changing their entropy. */
export const formatEmailCode = (input: {
  readonly symbols: string;
  readonly groupSize: number;
}): string => {
  const groups: Array<string> = [];
  for (let offset = 0; offset < input.symbols.length; offset += input.groupSize) {
    groups.push(input.symbols.slice(offset, offset + input.groupSize));
  }
  return groups.join("-");
};

/** Decides resend/supersession admission from one already-locked replacement workflow. */
export const decideEmailReplacementRequest = (input: {
  readonly existing: Option.Option<
    Readonly<{
      candidateMatches: boolean;
      deliveryGeneration: number;
      resendAvailableAt: DateTime.Utc;
      expiresAt: DateTime.Utc;
    }>
  >;
  readonly requestedAt: DateTime.Utc;
}): Effect.Effect<EmailReplacementRequestDecision> =>
  Effect.succeed(
    Option.match(input.existing, {
      onNone: () => "Start",
      onSome: (existing) => {
        if (DateTime.isGreaterThanOrEqualTo(input.requestedAt, existing.expiresAt)) {
          return "ReplaceExpired";
        }
        if (existing.deliveryGeneration >= maximumEmailDeliveryGenerations) return "Reject";
        if (
          existing.candidateMatches &&
          DateTime.isGreaterThan(existing.resendAvailableAt, input.requestedAt)
        ) {
          return "Reject";
        }
        return "UseExisting";
      },
    })
  );

/** Decides whether a locked BrowserLogin email workflow may create its next generation. */
export const decideBrowserPairingEmailRequest = (input: {
  readonly existing: Option.Option<
    Readonly<{
      credentialRevisionMatches: boolean;
      deliveryGeneration: number;
      resendAvailableAt: DateTime.Utc;
      expiresAt: DateTime.Utc;
    }>
  >;
  readonly requestedAt: DateTime.Utc;
  readonly processedAt: DateTime.Utc;
}): "Continue" | "Reject" =>
  Option.exists(
    input.existing,
    (workflow) =>
      DateTime.isGreaterThan(workflow.resendAvailableAt, input.requestedAt) ||
      DateTime.isGreaterThanOrEqualTo(input.processedAt, workflow.expiresAt) ||
      workflow.deliveryGeneration >= maximumEmailDeliveryGenerations ||
      !workflow.credentialRevisionMatches
  )
    ? "Reject"
    : "Continue";

/** Applies the enrollment's half-open lifetime at every owner boundary. */
export const isEmailEnrollmentExpired = (input: {
  readonly expiresAt: DateTime.Utc;
  readonly attemptedAt: DateTime.Utc;
}): boolean => DateTime.isGreaterThanOrEqualTo(input.attemptedAt, input.expiresAt);

const hasProofAttemptExpired = (input: ProofAttemptInput): boolean =>
  DateTime.isGreaterThanOrEqualTo(input.attemptedAt, input.proofExpiresAt) ||
  isEmailEnrollmentExpired({
    attemptedAt: input.attemptedAt,
    expiresAt: input.enrollmentExpiresAt,
  });

const wrongProofDecision = (wrongAttempts: number): ProofAttemptDecision =>
  wrongAttempts >= maximumWrongProofAttempts
    ? { _tag: "Delete" }
    : { _tag: "Wrong", wrongAttempts };

const liveProofDecision = (input: ProofAttemptInput): ProofAttemptDecision =>
  input.digestMatches ? { _tag: "Accept" } : wrongProofDecision(input.wrongAttempts + 1);

/**
 * Decides one proof attempt from already-locked current-generation state. The caller supplies the
 * stored attempt count and both validity bounds; the result is deterministic and performs no write.
 */
export const decideProofAttempt = (input: ProofAttemptInput): Effect.Effect<ProofAttemptDecision> =>
  Effect.succeed(hasProofAttemptExpired(input) ? { _tag: "Expired" } : liveProofDecision(input));

/** A fourth wrong proof closes the pending enrollment; later attempts cannot revive it. */
export const maximumOnboardingProofFailures = 4;

/** A proof is redeemable only during both its own lifetime and the pending enrollment's lifetime. */
export const canRedeemOnboardingProof = (
  input: Readonly<{
    state: "awaiting_proof" | "awaiting_delivery" | "sending" | "rejected" | "ambiguous";
    expiresAtMs: number;
    proofExpiresAtMs: number;
    nowMs: number;
  }>
): boolean =>
  input.state === "awaiting_proof" &&
  input.expiresAtMs > input.nowMs &&
  input.proofExpiresAtMs > input.nowMs;
