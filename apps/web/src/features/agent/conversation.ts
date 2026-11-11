import { useAtomSet } from "@effect/atom-react";
import { useState, useSyncExternalStore } from "react";
import type { HostedTurnClient } from "@/transport/hosted-turn-client";
import {
  type Conversation,
  type ConversationLifetime,
  type HostedConversation,
  type SetConversation,
  conversationCommands,
  initialConversation,
  presentHostedConversation,
} from "./conversation-state";

type ConversationOwner = Readonly<{
  current: () => Conversation;
  setConversation: SetConversation;
  subscribe: (listener: () => void) => () => void;
  capture: () => ConversationLifetime;
}>;
const conversationOwner = (clearAcceptedDraft: () => void): ConversationOwner => {
  let conversation = initialConversation;
  let lifetime = Symbol();
  let active = false;
  const listeners = new Set<() => void>();
  const setConversation: SetConversation = (update) => {
    if (!active) return;
    conversation = typeof update === "function" ? update(conversation) : update;
    listeners.forEach((listener) => listener());
  };
  return {
    current: (): Conversation => conversation,
    setConversation,
    subscribe: (listener: () => void): (() => void) => {
      active = true;
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        active = false;
        lifetime = Symbol();
        conversation = { turn: { tag: "idle" }, history: [] };
      };
    },
    capture: (): ConversationLifetime => {
      const admitted = lifetime;
      const isActive = (): boolean => active && admitted === lifetime;
      return {
        active: isActive,
        setConversation: (update: Parameters<SetConversation>[0]): void => {
          if (isActive()) setConversation(update);
        },
        clearDraft: (): void => {
          if (isActive()) clearAcceptedDraft();
        },
      };
    },
  };
};

/**
 * Retains one mounted conversation and its private delivery material until disposal.
 * Call reply-bound visibility only after its exact text commits in an active, visible document.
 * Unresolved work blocks submissions; accepted proposals clear the caller's disabled draft.
 */
export const useHostedConversation = ({
  client,
  clearAcceptedDraft,
}: Readonly<{ client: HostedTurnClient; clearAcceptedDraft: () => void }>): HostedConversation => {
  const [owner] = useState(() => conversationOwner(clearAcceptedDraft));
  const [commands] = useState(() => conversationCommands({ client, capture: owner.capture }));
  const propose = useAtomSet(commands.propose);
  const progress = useAtomSet(commands.progress);
  const acknowledge = useAtomSet(commands.receipt);
  const conversation = useSyncExternalStore(owner.subscribe, owner.current);
  return presentHostedConversation({
    conversation,
    setConversation: owner.setConversation,
    current: owner.current,
    active: owner.capture().active,
    propose,
    progress,
    acknowledge,
  });
};
