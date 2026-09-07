import { Data } from "effect";
import type { UserId } from "~/core/identity/reference";

/** Failure returned before any model or Transcript work when onboarding Consent is absent. */
export class OnboardingConsentRequired extends Data.TaggedError("OnboardingConsentRequired")<{
  readonly userId: UserId;
}> {
  override get message(): string {
    return "The User has no current onboarding consent";
  }
}
