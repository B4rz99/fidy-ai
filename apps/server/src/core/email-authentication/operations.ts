import { DateTime, Effect, Option } from "effect";
import {
  type EmailReplacementRequestDecision,
  ProofAttemptDecision,
  type ProofAttemptInput,
  maximumEmailDeliveryGenerations,
} from "./contract";

export const emailCodeAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789" as const;

const maximumWrongProofAttempts = 5;

export const emailWorkflowExpiry = (startedAt: DateTime.Utc): DateTime.Utc =>
  DateTime.add(startedAt, { hours: 24 });

export const proofExpiry = (generatedAt: DateTime.Utc): DateTime.Utc =>
  DateTime.add(generatedAt, { minutes: 10 });

export const selectEmailCodeSymbols = (input: {
  readonly bytes: ArrayLike<number>;
  readonly maximum: number;
}): string =>
  Array.from(input.bytes)
    .slice(0, input.maximum)
    .map((byte) => emailCodeAlphabet[byte % emailCodeAlphabet.length])
    .join("");

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
    ? ProofAttemptDecision.Delete()
    : ProofAttemptDecision.Wrong({ wrongAttempts });

const liveProofDecision = (input: ProofAttemptInput): ProofAttemptDecision =>
  input.digestMatches ? ProofAttemptDecision.Accept() : wrongProofDecision(input.wrongAttempts + 1);

export const decideProofAttempt = (input: ProofAttemptInput): Effect.Effect<ProofAttemptDecision> =>
  Effect.succeed(
    hasProofAttemptExpired(input) ? ProofAttemptDecision.Expired() : liveProofDecision(input)
  );

export const maximumOnboardingProofFailures = 4;

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
