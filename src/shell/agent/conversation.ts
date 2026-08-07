import { Effect, Option, Schema } from "effect";
import {
  type ConsentGateInput,
  type ConsentGateOutcome,
  evaluateConsentGate,
} from "~/shell/consent/consent-gate";
import { type AgentReply, AgentService, InboundMessage } from "./agent-service";

/**
 * Consent-terminal outcome or a validated text turn bound to the resolved stable User. Admission
 * may persist consent state through the consent gate, but never invokes AgentService.
 */
export type AgentConversationAdmission =
  | Exclude<ConsentGateOutcome, { readonly _tag: "Proceed" }>
  | Readonly<{
      readonly _tag: "AuthorizedTurn";
      readonly userId: Extract<ConsentGateOutcome, { readonly _tag: "Proceed" }>["userId"];
      readonly inboundMessage: InboundMessage;
    }>;

/** Tells an adapter whether consent ended the turn or an authorized agent reply may be sent. */
export type AgentConversationOutcome =
  | Exclude<ConsentGateOutcome, { readonly _tag: "Proceed" }>
  | Readonly<{ readonly _tag: "AgentReplied"; readonly reply: AgentReply }>;

const invalidAgentMessage = (): Exclude<ConsentGateOutcome, { readonly _tag: "Proceed" }> => ({
  _tag: "ClarifyDecision",
  text: "Escribe un mensaje de texto no vacío de hasta 16.000 caracteres.",
});

/**
 * Evaluates the consent gate, preserving its typed failures and side effects, then validates
 * admitted text against InboundMessage. Consent outcomes terminate; valid text returns an
 * AuthorizedTurn without invoking the model.
 */
export const admitAgentConversationTurn = Effect.fn("admitAgentConversationTurn")(function* (
  input: ConsentGateInput
) {
  const gate = yield* evaluateConsentGate(input);
  if (gate._tag !== "Proceed") return gate;
  if (input.content._tag !== "Text") return invalidAgentMessage();

  const inbound = Schema.decodeUnknownOption(InboundMessage)({ text: input.content.text });
  if (Option.isNone(inbound)) return invalidAgentMessage();
  return { _tag: "AuthorizedTurn", userId: gate.userId, inboundMessage: inbound.value } as const;
});

/**
 * Owns the immediate channel-neutral conversation boundary. Consent outcomes terminate the turn;
 * only admitted text enters AgentService. Consent-gate and AgentService failures are preserved,
 * and successful AgentService execution may persist canonical state and transcript evidence.
 */
export const handleAgentConversationTurn = Effect.fn("handleAgentConversationTurn")(function* (
  input: ConsentGateInput
) {
  const admission = yield* admitAgentConversationTurn(input);
  if (admission._tag !== "AuthorizedTurn") return admission;
  const service = yield* AgentService;
  const reply = yield* service.handleSynchronousTurn(admission.userId, admission.inboundMessage);
  return { _tag: "AgentReplied", reply } as const;
});
