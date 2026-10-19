import { useRouter } from "@tanstack/react-router";
import { Option } from "effect";
import { useState } from "react";
import type { JSX, SubmitEvent } from "react";
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

/** Retains chat through dismissal/navigation; authenticated-layout unmount discards it. */
export const HostedAgentFeature = (): JSX.Element => {
  const client = useRouter().options.context.hostedTurnClient;
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const conversation = useHostedConversation({ client, clearDraft: () => setText("") });
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
