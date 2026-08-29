import { Effect, Option, Schema } from "effect";
import {
  type OnboardingTurn,
  type OnboardingTurnOutcome,
  handleOnboardingTurn,
} from "~/shell/onboarding/onboarding";
import { type AgentReply, AgentService, InboundMessage } from "./agent-service";

/**
 * Onboarding-terminal outcome or a validated text turn bound to the resolved stable User. Admission
 * may persist onboarding state through the deep process, but never invokes AgentService.
 */
export type AgentConversationAdmission =
  | Exclude<OnboardingTurnOutcome, { readonly _tag: "Proceed" }>
  | Readonly<{
      readonly _tag: "AuthorizedTurn";
      readonly userId: Extract<OnboardingTurnOutcome, { readonly _tag: "Proceed" }>["userId"];
      readonly inboundMessage: InboundMessage;
    }>;

/** Tells an adapter whether onboarding ended the turn or an authorized reply may be sent. */
export type AgentConversationOutcome =
  | Exclude<OnboardingTurnOutcome, { readonly _tag: "Proceed" }>
  | Readonly<{ readonly _tag: "AgentReplied"; readonly reply: AgentReply }>;

const invalidAgentMessage = (): Exclude<OnboardingTurnOutcome, { readonly _tag: "Proceed" }> => ({
  _tag: "ClarifyDecision",
  reason: "invalid-message",
});

/**
 * Evaluates verified onboarding, preserving its typed outcomes and side effects, then validates
 * admitted text against InboundMessage. Onboarding outcomes terminate; valid text returns an
 * AuthorizedTurn without invoking the model.
 */
export const admitAgentConversationTurn = Effect.fn("admitAgentConversationTurn")(function* (
  input: OnboardingTurn
) {
  const onboarding = yield* handleOnboardingTurn(input);
  if (onboarding._tag !== "Proceed") return onboarding;
  if (input.content._tag !== "Text") return invalidAgentMessage();

  const inbound = Schema.decodeOption(InboundMessage)({ text: input.content.text });
  if (Option.isNone(inbound)) return invalidAgentMessage();
  return {
    _tag: "AuthorizedTurn",
    userId: onboarding.userId,
    inboundMessage: inbound.value,
  } as const;
});

/**
 * Owns the immediate channel-neutral conversation boundary. Onboarding outcomes terminate the turn;
 * only admitted text enters AgentService. Process and AgentService failures are preserved, and
 * successful AgentService execution may persist canonical state and Transcript evidence.
 */
export const handleAgentConversationTurn = Effect.fn("handleAgentConversationTurn")(function* (
  input: OnboardingTurn
) {
  const admission = yield* admitAgentConversationTurn(input);
  if (admission._tag !== "AuthorizedTurn") return admission;
  const service = yield* AgentService;
  const reply = yield* service.handleMessage(
    admission.userId,
    admission.inboundMessage,
    () => Effect.void
  );
  return { _tag: "AgentReplied", reply } as const;
});
