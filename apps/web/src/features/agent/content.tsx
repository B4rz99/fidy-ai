import { Option } from "effect";
import type { JSX, SubmitEvent } from "react";
import { Conversation, ConversationScrollButton } from "@/ui/components/ai-elements/conversation";
import { Message, MessageContent } from "@/ui/components/ai-elements/message";
import { ChatComposer } from "@/ui/components/chat";
import {
  ChatConfirmation,
  ChatContent,
  ChatRecovery,
  ChatStart,
  ChatStatus,
} from "@/ui/components/chat-content";
import type { HostedConversation, VisibleAgentReply } from "./conversation-state";
import { VisibleReply } from "./visible-reply";

export const AgentContent = ({
  conversation,
  open,
  text,
  setText,
}: Readonly<{
  conversation: HostedConversation;
  open: boolean;
  text: string;
  setText: (text: string) => void;
}>): JSX.Element => {
  const { display } = conversation;
  const onSubmit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    conversation.submit(text);
  };
  return (
    <>
      <Conversation className="min-h-0" aria-label="Conversación con Fidy">
        <ChatContent>
          {display.empty && <ChatStart onSelect={setText} />}
          {display.history.map((entry) => (
            <Message key={entry.id} from={entry.from}>
              <MessageContent>{entry.text}</MessageContent>
            </Message>
          ))}
          {Option.isSome(display.reply) && (
            <AgentReply
              reply={display.reply.value}
              active={open}
              canSubmit={display.canSubmit}
              key={display.reply.value.id}
            />
          )}
          <ChatStatus text={display.status} kind={display.statusKind} />
          {display.canCheckProgress && (
            <ChatRecovery onClick={conversation.checkProgress}>Consultar estado</ChatRecovery>
          )}
          {display.canRetryDelivery && (
            <ChatRecovery onClick={conversation.retryDelivery}>Reintentar conexión</ChatRecovery>
          )}
        </ChatContent>
        <ConversationScrollButton />
      </Conversation>
      <ChatComposer
        text={text}
        disabled={!display.canSubmit}
        onTextChange={setText}
        onSubmit={onSubmit}
      />
    </>
  );
};
const AgentReply = ({
  reply,
  active,
  canSubmit,
}: Readonly<{
  reply: VisibleAgentReply;
  active: boolean;
  canSubmit: boolean;
}>): JSX.Element => (
  <VisibleReply active={active && reply.awaitingVisibility} onVisible={reply.onVisible}>
    <Message from="assistant" aria-label="Respuesta del agente">
      <MessageContent>{reply.text}</MessageContent>
      {Option.isSome(reply.confirm) && (
        <ChatConfirmation disabled={!canSubmit} onConfirm={reply.confirm.value} />
      )}
    </Message>
  </VisibleReply>
);
