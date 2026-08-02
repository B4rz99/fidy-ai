import { Effect, Option, Schema } from "effect";
import {
  type ConsentGateInput,
  type ConsentGateOutcome,
  evaluateConsentGate,
} from "~/shell/consent/consent-gate";
import { AgentService, InboundMessage, type AgentReply } from "./agent-service";

/** Tells an adapter whether consent ended the turn or an authorized agent reply may be sent. */
export type AgentConversationOutcome =
  | Exclude<ConsentGateOutcome, { readonly _tag: "Proceed" }>
  | Readonly<{ readonly _tag: "AgentReplied"; readonly reply: AgentReply }>;

const invalidAgentMessage = (): AgentConversationOutcome => ({
  _tag: "ClarifyDecision",
  text: "Escribe un mensaje de texto no vacío de hasta 16.000 caracteres.",
});

/**
 * Owns the channel-neutral conversation boundary. Consent outcomes terminate
 * the turn; only an already-authorized text turn enters AgentService. An
 * authorized turn preserves AgentService's closed `UnknownUser`,
 * `OnboardingConsentRequired`, and `ModelUnavailable` failures for the adapter.
 */
export const handleAgentConversationTurn = Effect.fn("handleAgentConversationTurn")(function* (
  input: ConsentGateInput
) {
  const gate = yield* evaluateConsentGate(input);
  if (gate._tag !== "Proceed") return gate;
  if (input.content._tag !== "Text") return invalidAgentMessage();

  const inbound = Schema.decodeUnknownOption(InboundMessage)({ text: input.content.text });
  if (Option.isNone(inbound)) return invalidAgentMessage();

  const service = yield* AgentService;
  const reply = yield* service.handleTurn(gate.userId, inbound.value);
  return { _tag: "AgentReplied", reply } as const;
});
