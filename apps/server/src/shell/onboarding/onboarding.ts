import { Data, Effect, type Redacted } from "effect";
import { completeVerifiedOnboardingTransition } from "./completion-transition";
import { handleOnboardingTurnTransition } from "./turn-transition";
import type { OnboardingTurn } from "./types";

export type {
  CompleteVerifiedOnboardingResult,
  OnboardingTurn,
  OnboardingTurnOutcome,
} from "./types";

/** Fieldless semantic rejection shared by every invalid verification state. */
export class VerificationRejected extends Data.TaggedError("VerificationRejected")<{}> {}

/**
 * Advances one authenticated WhatsApp onboarding turn. It may persist bounded Consent and email
 * enrollment state; only `Proceed` identifies a complete stable User, and semantic rejections stay
 * closed outcomes rather than failures.
 */
export const handleOnboardingTurn = Effect.fn("Onboarding.handleTurn")((input: OnboardingTurn) =>
  handleOnboardingTurnTransition(input)
);

/**
 * Consumes one redacted combined email code and atomically creates every mandatory stable-User
 * record. It discloses the BackupRecoveryCode once on success; every invalid state fails with the
 * fieldless `VerificationRejected` error and commits no partial owner writes.
 */
export const completeVerifiedOnboarding = Effect.fn("Onboarding.complete")(function* (input: {
  readonly combinedCode: Redacted.Redacted<unknown>;
}) {
  return yield* completeVerifiedOnboardingTransition(input).pipe(
    Effect.catchTags({
      EmailVerificationInvalid: () => new VerificationRejected(),
      EmailAlreadyEnrolled: () => new VerificationRejected(),
    })
  );
});
