import { useRouter } from "@tanstack/react-router";
import { Option } from "effect";
import { createContext, useContext, useState } from "react";
import type { JSX, ReactNode, SubmitEvent } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/ui/components/ai-elements/conversation";
import { Message, MessageContent } from "@/ui/components/ai-elements/message";
import { ChatComposer, ChatWindow } from "@/ui/components/chat";
import { Button } from "@/ui/components/button";
import { type VisibleAgentReply, useHostedConversation } from "./conversation";
import { VisibleReply } from "./visible-reply";

type AgentState = Readonly<{
  conversation: ReturnType<typeof useHostedConversation>;
  open: boolean;
  setOpen: (open: boolean) => void;
  text: string;
  setText: (text: string) => void;
}>;
const AgentContext = createContext<Option.Option<AgentState>>(Option.none());

/** One conversation spans independently authorized product routes in the application shell. */
export const HostedAgentProvider = ({
  children,
}: Readonly<{ children: ReactNode }>): JSX.Element => {
  const client = useRouter().options.context.hostedTurnClient;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const conversation = useHostedConversation({ client, clearDraft: () => setText("") });
  return (
    <AgentContext.Provider value={Option.some({ conversation, open, setOpen, text, setText })}>
      {children}
    </AgentContext.Provider>
  );
};

/** Route authorization controls visibility; the application lifetime owns the conversation. */
export const HostedAgentFeature = (): JSX.Element => {
  const state = useContext(AgentContext);
  if (Option.isNone(state)) throw new Error("HostedAgentFeature requires HostedAgentProvider");
  const { conversation, open, setOpen, text, setText } = state.value;
  const { view } = conversation;
  const onSubmit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    conversation.submit(text);
  };
  return (
    <ChatWindow open={open} onOpenChange={setOpen}>
      <Conversation className="min-h-0" aria-label="Conversación con Fidy">
        <ConversationContent className="gap-4">
          {view.empty && <ConversationEmptyState />}
          {view.history.map((entry) => (
            <Message key={entry.id} from={entry.from}>
              <MessageContent>{entry.text}</MessageContent>
            </Message>
          ))}
          {Option.isSome(view.reply) && (
            <AgentReply
              reply={view.reply.value}
              active={open}
              canSubmit={view.canSubmit}
              onVisible={conversation.replyVisible}
              confirm={conversation.confirm}
            />
          )}
          {view.status !== "" && (
            <p aria-live="polite" className="text-xs text-muted-foreground">
              {view.status}
            </p>
          )}
          {view.canCheckProgress && (
            <Button onClick={conversation.checkProgress} type="button">
              Consultar estado
            </Button>
          )}
          {view.canRetryDelivery && (
            <Button onClick={conversation.retryDelivery} type="button">
              Reintentar conexión
            </Button>
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>
      <ChatComposer
        text={text}
        disabled={!view.canSubmit}
        onTextChange={setText}
        onSubmit={onSubmit}
      />
    </ChatWindow>
  );
};

const AgentReply = ({
  reply,
  active,
  canSubmit,
  onVisible,
  confirm,
}: Readonly<{
  reply: VisibleAgentReply;
  active: boolean;
  canSubmit: boolean;
  onVisible: () => void;
  confirm: () => void;
}>): JSX.Element => (
  <VisibleReply active={active && reply.awaitingVisibility} onVisible={onVisible}>
    <Message from="assistant" aria-label="Respuesta del agente">
      <MessageContent>{reply.text}</MessageContent>
      {reply.confirmation && (
        <Button type="button" disabled={!canSubmit} onClick={confirm}>
          Confirmar cambio
        </Button>
      )}
    </Message>
  </VisibleReply>
);
