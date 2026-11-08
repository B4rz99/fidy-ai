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
  const { view } = conversation;
  const onSubmit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    conversation.submit(text);
  };
  return (
    <>
      <Conversation className="min-h-0" aria-label="Conversación con Fidy">
        <ChatContent>
          {view.empty && <ChatStart onSelect={setText} />}
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
          <ChatStatus text={view.status} kind={view.statusKind} />
          {view.canCheckProgress && (
            <ChatRecovery onClick={conversation.checkProgress}>Consultar estado</ChatRecovery>
          )}
          {view.canRetryDelivery && (
            <ChatRecovery onClick={conversation.retryDelivery}>Reintentar conexión</ChatRecovery>
          )}
        </ChatContent>
        <ConversationScrollButton />
      </Conversation>
      <ChatComposer
        text={text}
        disabled={!view.canSubmit}
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
      {reply.confirmation && <ChatConfirmation disabled={!canSubmit} onConfirm={confirm} />}
    </Message>
  </VisibleReply>
);
