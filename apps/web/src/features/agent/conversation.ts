import { useAtomSet } from "@effect/atom-react";
import { Option } from "effect";
import { useRef, useState } from "react";
import type { HostedTurnClient } from "@/transport/hosted-turn-client";
import {
  type HostedConversation,
  conversationCommands,
  initialConversation,
  presentConversation,
  presentHostedConversation,
} from "./conversation-state";

const initialDeliveredTurn = Option.none<string>();

/**
 * Owns one mounted conversation, including exact receipt retention and bounded visible history.
 * Mount with the authenticated layout so dismissal/navigation retain it and logout discards it.
 * Presentation reports a committed, visible reply; only this module decides whether to acknowledge
 * it. Unresolved execution or delivery blocks submission. clearDraft runs after a successful
 * proposal response, while the draft is still disabled. No conversation state is persisted.
 */
export const useHostedConversation = ({
  client,
  clearDraft,
}: Readonly<{ client: HostedTurnClient; clearDraft: () => void }>): HostedConversation => {
  const [conversation, setConversation] = useState(initialConversation);
  const [commands] = useState(() => conversationCommands({ client, setConversation, clearDraft }));
  const propose = useAtomSet(commands.propose);
  const progress = useAtomSet(commands.progress);
  const acknowledge = useAtomSet(commands.receipt);
  const deliveredTurn = useRef(initialDeliveredTurn);
  const actions = (): HostedConversation =>
    presentHostedConversation({
      conversation,
      setConversation,
      propose,
      progress,
      acknowledge,
      deliveredTurn,
    });
  return {
    view: presentConversation(conversation),
    submit: (text) => actions().submit(text),
    confirm: () => actions().confirm(),
    replyVisible: () => actions().replyVisible(),
    checkProgress: () => actions().checkProgress(),
    retryDelivery: () => actions().retryDelivery(),
  };
};
