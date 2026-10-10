import { browserCrypto } from "@/browser/crypto";
import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Effect, Option, Schema } from "effect";
import type { Atom } from "effect/reactivity";
import { useRef, useState } from "react";
import type { Dispatch, JSX, SetStateAction, SubmitEvent } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/ui/components/ai-elements/conversation";
import { Message, MessageContent } from "@/ui/components/ai-elements/message";
import { ChatComposer, ChatWindow } from "@/ui/components/chat";
import { Button } from "@/ui/components/button";
import { HostedTurnRequest } from "@/transport/client";
import type {
  HostedTurnClient,
  HostedTurnProcessing,
  HostedTurnProposal,
  HostedTurnReceipt,
} from "@/transport/client";

import { VisibleReply } from "./visible-reply";

type Proposal = typeof HostedTurnProposal.Type;
type Processing = typeof HostedTurnProcessing.Type;
type HostedReply = Proposal | Processing;
type TurnState =
  | Readonly<{ tag: "idle" | "waiting" | "error" }>
  | Readonly<{ tag: "proposal"; value: Proposal }>
  | Readonly<{ tag: "processing" | "uncertain"; value: Processing }>
  | Readonly<{ tag: "confirming" | "completed" | "unconfirmed"; value: Proposal }>;

type ProposeCommand = Readonly<{
  payload: typeof HostedTurnRequest.Type;
  onProposed: (proposal: HostedReply) => void;
  onFailed: () => void;
}>;
type ProgressCommand = Readonly<{
  payload: Processing;
  onProposed: (proposal: HostedReply) => void;
  onFailed: () => void;
}>;
type ReceiptCommand = Readonly<{
  payload: typeof HostedTurnReceipt.Type;
  onCompleted: () => void;
  onFailed: () => void;
}>;

const proposeCommand = (client: HostedTurnClient): Atom.AtomResultFn<ProposeCommand, void, never> =>
  client.runtime.fn<ProposeCommand>()(
    (command) =>
      Effect.gen(function* () {
        const channel = yield* client;
        const proposal = yield* channel.hostedTurn.propose({ payload: command.payload });
        yield* Effect.sync(() => command.onProposed(proposal));
      }).pipe(Effect.catch(() => Effect.sync(command.onFailed))),
    { concurrent: false }
  );
const progressCommand = (
  client: HostedTurnClient
): Atom.AtomResultFn<ProgressCommand, void, never> =>
  client.runtime.fn<ProgressCommand>()(
    (command) =>
      Effect.gen(function* () {
        const channel = yield* client;
        const proposal = yield* channel.hostedTurn.progress({
          payload: { turnId: command.payload.turnId },
        });
        yield* Effect.sync(() => command.onProposed(proposal));
      }).pipe(Effect.catch(() => Effect.sync(command.onFailed))),
    { concurrent: false }
  );
const receiptCommand = (client: HostedTurnClient): Atom.AtomResultFn<ReceiptCommand, void, never> =>
  client.runtime.fn<ReceiptCommand>()(
    (command) =>
      Effect.gen(function* () {
        const channel = yield* client;
        yield* channel.hostedTurn.acknowledge({ payload: command.payload });
        yield* Effect.sync(command.onCompleted);
      }).pipe(Effect.catch(() => Effect.sync(command.onFailed))),
    { concurrent: false }
  );

const status: Readonly<Record<TurnState["tag"], string>> = {
  idle: "",
  waiting: "Esperando respuesta…",
  error: "No se pudo completar el turno. Inténtalo de nuevo.",
  proposal: "",
  processing: "El turno sigue en curso. Consulta el estado antes de volver a intentarlo.",
  uncertain:
    "No se pudo recuperar el turno. Una operación podría haberse ejecutado: consulta tus datos antes de reintentar.",
  confirming: "",
  completed: "",
  unconfirmed: "No pudimos guardar la respuesta. Reintenta la conexión para continuar.",
};

const replyText = (turn: TurnState): Option.Option<string> => {
  if (!("value" in turn) || "status" in turn.value) return Option.none();
  return Option.some(turn.value.text);
};

const AgentReply = ({
  turn,
  open,
  onVisible,
  onConfirm,
  onProgress,
}: Readonly<{
  turn: TurnState;
  open: boolean;
  onVisible: (proposal: Proposal) => void;
  onConfirm: (proposal: Proposal) => void;
  onProgress: (pending: Processing) => void;
}>): JSX.Element => {
  const reply = replyText(turn);
  return (
    <>
      {Option.isSome(reply) && (
        <VisibleReply
          active={open && turn.tag === "proposal"}
          onVisible={() => {
            if (turn.tag === "proposal") onVisible(turn.value);
          }}
        >
          <Message from="assistant" aria-label="Respuesta del agente">
            <MessageContent>{reply.value}</MessageContent>
          </Message>
        </VisibleReply>
      )}
      {status[turn.tag] !== "" ? (
        <p aria-live="polite" className="text-xs text-muted-foreground">
          {status[turn.tag]}
        </p>
      ) : null}
      {(turn.tag === "processing" || turn.tag === "uncertain") && (
        <Button onClick={() => onProgress(turn.value)} type="button">
          Consultar estado
        </Button>
      )}
      {turn.tag === "unconfirmed" && (
        <Button onClick={() => onConfirm(turn.value)} type="button">
          Reintentar conexión
        </Button>
      )}
    </>
  );
};

const progressHandler =
  (
    run: (command: ProgressCommand) => void,
    setTurn: (next: TurnState) => void
  ): ((pending: Processing) => void) =>
  (pending) => {
    run({
      payload: pending,
      onProposed: (value) =>
        setTurn("status" in value ? { tag: "processing", value } : { tag: "proposal", value }),
      onFailed: () => setTurn({ tag: "uncertain", value: pending }),
    });
  };

const receiptHandler =
  (
    run: (command: ReceiptCommand) => void,
    setTurn: (next: TurnState) => void
  ): ((value: Proposal) => void) =>
  (value) => {
    setTurn({ tag: "confirming", value });
    run({
      payload: { turnId: value.turnId, receipt: value.receipt },
      onCompleted: () => setTurn({ tag: "completed", value }),
      onFailed: () => setTurn({ tag: "unconfirmed", value }),
    });
  };

type Entry = Readonly<{ id: string; from: "user" | "assistant"; text: string }>;
const visibleHistoryLimit = 40;
const blocksSubmission = (turn: TurnState): boolean =>
  !["idle", "error", "completed"].includes(turn.tag);

type Submission = Readonly<{
  text: string;
  turn: TurnState;
  propose: (command: ProposeCommand) => void;
  setTurn: (turn: TurnState) => void;
  setText: (text: string) => void;
  setHistory: Dispatch<SetStateAction<ReadonlyArray<Entry>>>;
}>;
const submitMessage = (input: Submission): void => {
  if (blocksSubmission(input.turn)) return;
  const decoded = Schema.decodeOption(HostedTurnRequest)({ text: input.text });
  if (Option.isNone(decoded)) {
    input.setTurn({ tag: "error" });
    return;
  }
  const entry: Entry = {
    id: Effect.runSync(browserCrypto.randomUUIDv4.pipe(Effect.orDie)),
    from: "user",
    text: decoded.value.text,
  };
  const previous: ReadonlyArray<Entry> =
    input.turn.tag === "completed"
      ? [{ id: input.turn.value.turnId, from: "assistant", text: input.turn.value.text }]
      : [];
  input.setHistory((entries) => [...entries, ...previous, entry].slice(-visibleHistoryLimit));
  input.setTurn({ tag: "waiting" });
  input.propose({
    payload: decoded.value,
    onProposed: (value) => {
      input.setText("");
      input.setTurn("status" in value ? { tag: "processing", value } : { tag: "proposal", value });
    },
    onFailed: () => {
      input.setHistory((entries) => entries.filter((item) => item.id !== entry.id));
      input.setTurn({ tag: "error" });
    },
  });
};

type ChatViewProps = Readonly<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  history: ReadonlyArray<Entry>;
  turn: TurnState;
  text: string;
  onTextChange: (text: string) => void;
  onSubmit: (event: SubmitEvent<HTMLFormElement>) => void;
  onVisible: (proposal: Proposal) => void;
  onConfirm: (proposal: Proposal) => void;
  onProgress: (pending: Processing) => void;
}>;
const ChatView = (props: ChatViewProps): JSX.Element => (
  <ChatWindow open={props.open} onOpenChange={props.onOpenChange}>
    <Conversation className="min-h-0" aria-label="Conversación con Fidy">
      <ConversationContent className="gap-4">
        {props.history.length === 0 && props.turn.tag === "idle" ? (
          <ConversationEmptyState />
        ) : null}
        {props.history.map((entry) => (
          <Message key={entry.id} from={entry.from}>
            <MessageContent>{entry.text}</MessageContent>
          </Message>
        ))}
        <AgentReply
          open={props.open}
          onVisible={props.onVisible}
          onConfirm={props.onConfirm}
          onProgress={props.onProgress}
          turn={props.turn}
        />
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
    <ChatComposer
      text={props.text}
      disabled={blocksSubmission(props.turn)}
      onTextChange={props.onTextChange}
      onSubmit={props.onSubmit}
    />
  </ChatWindow>
);

const initialDeliveredTurn = Option.none<string>();

/** Chat state outlives popup dismissal and navigation, but never the authenticated layout. */
export const HostedAgentFeature = (): JSX.Element => {
  const client = useRouter().options.context.hostedTurnClient;
  const [proposeAtom] = useState(() => proposeCommand(client));
  const [receiptAtom] = useState(() => receiptCommand(client));
  const [progressAtom] = useState(() => progressCommand(client));
  const propose = useAtomSet(proposeAtom);
  const acknowledge = useAtomSet(receiptAtom);
  const progress = useAtomSet(progressAtom);
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<ReadonlyArray<Entry>>([]);
  const [text, setText] = useState("");
  const [turn, setTurn] = useState<TurnState>({ tag: "idle" });
  const deliveredTurn = useRef(initialDeliveredTurn);
  const onVisible = (value: Proposal): void => {
    if (Option.isSome(deliveredTurn.current) && deliveredTurn.current.value === value.turnId) {
      return;
    }
    deliveredTurn.current = Option.some(value.turnId);
    receiptHandler(acknowledge, setTurn)(value);
  };
  const onSubmit = (event: SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    submitMessage({ text, turn, propose, setTurn, setText, setHistory });
  };
  return (
    <ChatView
      open={open}
      onOpenChange={setOpen}
      history={history}
      turn={turn}
      text={text}
      onTextChange={setText}
      onSubmit={onSubmit}
      onVisible={onVisible}
      onProgress={progressHandler(progress, setTurn)}
      onConfirm={receiptHandler(acknowledge, setTurn)}
    />
  );
};
