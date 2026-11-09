import { lazyRouteComponent } from "@tanstack/react-router";
import { Option } from "effect";
import { Suspense, createContext, useContext, useState } from "react";
import type { JSX, ReactNode } from "react";
import type { HostedTurnClient } from "@/transport/hosted-turn-client";
import { ChatWindow } from "@/ui/components/chat";
import { PendingRead } from "@/ui/components/pending-read";
import { useHostedConversation } from "./conversation";

const AgentContent = lazyRouteComponent(() => import("./content"), "AgentContent");

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
  client,
}: Readonly<{ children: ReactNode; client: HostedTurnClient }>): JSX.Element => {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const conversation = useHostedConversation({ client, clearDraft: () => setText("") });
  return (
    <AgentContext.Provider value={Option.some({ conversation, open, setOpen, text, setText })}>
      {children}
    </AgentContext.Provider>
  );
};

export const HostedAgentFeature = (): JSX.Element => {
  const state = useContext(AgentContext);
  if (Option.isNone(state)) throw new Error("HostedAgentFeature requires HostedAgentProvider");
  const { conversation, open, setOpen, text, setText } = state.value;
  return (
    <ChatWindow
      open={open}
      onOpenChange={setOpen}
      prepare={() => {
        AgentContent.preload?.()?.catch(() => undefined);
      }}
    >
      <Suspense fallback={<PendingRead label="Cargando conversación" />}>
        <AgentContent conversation={conversation} open={open} text={text} setText={setText} />
      </Suspense>
    </ChatWindow>
  );
};

HostedAgentFeature.preloadInteractions = (): Promise<void> =>
  Promise.resolve(AgentContent.preload?.()).then(() => undefined);
