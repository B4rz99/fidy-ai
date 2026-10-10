import { browserCrypto } from "@/browser/crypto";
import { useAtomSet } from "@effect/atom-react";
import { Effect, Option, Schema } from "effect";
import type { Atom } from "effect/reactivity";
import { useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import { HostedTurnRequest } from "@/transport/client";
import type {
  HostedTurnClient,
  HostedTurnProcessing,
  HostedTurnProposal,
} from "@/transport/client";

type Proposal = typeof HostedTurnProposal.Type;
type Processing = typeof HostedTurnProcessing.Type;
type Turn =
  | Readonly<{ tag: "idle" | "waiting" | "error" }>
  | Readonly<{ tag: "proposal"; value: Proposal }>
  | Readonly<{ tag: "processing" | "uncertain"; value: Processing }>
  | Readonly<{ tag: "confirming" | "completed" | "unconfirmed"; value: Proposal }>;
type Entry = Readonly<{ id: string; from: "user" | "assistant"; text: string }>;
type Conversation = Readonly<{ turn: Turn; history: ReadonlyArray<Entry> }>;
type SetConversation = Dispatch<SetStateAction<Conversation>>;
const visibleHistoryLimit = 40;
const initialConversation: Conversation = { turn: { tag: "idle" }, history: [] };
const noDeliveredTurn = Option.none<string>();

const status: Readonly<Record<Turn["tag"], string>> = {
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
const proposedTurn = (value: Proposal | Processing): Turn =>
  "status" in value ? { tag: "processing", value } : { tag: "proposal", value };
const canSubmit = (turn: Turn): boolean => ["idle", "error", "completed"].includes(turn.tag);
const setTurn = (setConversation: SetConversation, turn: Turn): void =>
  setConversation((previous) => ({ ...previous, turn }));

type Submission = Readonly<{ payload: typeof HostedTurnRequest.Type; entryId: string }>;
type Commands = Readonly<{
  propose: Atom.AtomResultFn<Submission, void, never>;
  progress: Atom.AtomResultFn<Processing, void, never>;
  receipt: Atom.AtomResultFn<Proposal, void, never>;
}>;
const rejectSubmission = (setConversation: SetConversation, entryId: string): Effect.Effect<void> =>
  Effect.sync(() =>
    setConversation((previous) => ({
      turn: { tag: "error" },
      history: previous.history.filter((entry) => entry.id !== entryId),
    }))
  );

// Commands retain the exact proposal privately; their callers never supply transition callbacks.
const conversationCommands = (
  client: HostedTurnClient,
  setConversation: SetConversation,
  clearDraft: () => void
): Commands => ({
  propose: client.runtime.fn<Submission>()(
    ({ payload, entryId }) =>
      Effect.gen(function* () {
        const channel = yield* client;
        const reply = yield* channel.hostedTurn.propose({ payload });
        yield* Effect.sync(() => {
          clearDraft();
          setTurn(setConversation, proposedTurn(reply));
        });
      }).pipe(Effect.catch(() => rejectSubmission(setConversation, entryId))),
    { concurrent: false }
  ),
  progress: client.runtime.fn<Processing>()(
    (pending) =>
      Effect.gen(function* () {
        const channel = yield* client;
        const reply = yield* channel.hostedTurn.progress({ payload: { turnId: pending.turnId } });
        yield* Effect.sync(() => setTurn(setConversation, proposedTurn(reply)));
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => setTurn(setConversation, { tag: "uncertain", value: pending }))
        )
      ),
    { concurrent: false }
  ),
  receipt: client.runtime.fn<Proposal>()(
    (proposal) =>
      Effect.gen(function* () {
        const channel = yield* client;
        yield* channel.hostedTurn.acknowledge({
          payload: { turnId: proposal.turnId, receipt: proposal.receipt },
        });
        yield* Effect.sync(() => setTurn(setConversation, { tag: "completed", value: proposal }));
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => setTurn(setConversation, { tag: "unconfirmed", value: proposal }))
        )
      ),
    { concurrent: false }
  ),
});

type ConversationView = Readonly<{
  history: ReadonlyArray<Entry>;
  reply: Option.Option<Readonly<{ text: string; awaitingVisibility: boolean }>>;
  status: string;
  empty: boolean;
  canSubmit: boolean;
  canCheckProgress: boolean;
  canRetryDelivery: boolean;
}>;
const presentConversation = ({ turn, history }: Conversation): ConversationView => ({
  history,
  reply:
    "value" in turn && !("status" in turn.value)
      ? Option.some({ text: turn.value.text, awaitingVisibility: turn.tag === "proposal" })
      : Option.none(),
  status: status[turn.tag],
  empty: history.length === 0 && turn.tag === "idle",
  canSubmit: canSubmit(turn),
  canCheckProgress: turn.tag === "processing" || turn.tag === "uncertain",
  canRetryDelivery: turn.tag === "unconfirmed",
});
type HostedConversation = Readonly<{
  view: ConversationView;
  submit: (text: string) => void;
  replyVisible: () => void;
  checkProgress: () => void;
  retryDelivery: () => void;
}>;

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
  const [commands] = useState(() => conversationCommands(client, setConversation, clearDraft));
  const propose = useAtomSet(commands.propose);
  const progress = useAtomSet(commands.progress);
  const acknowledge = useAtomSet(commands.receipt);
  const deliveredTurn = useRef(noDeliveredTurn);
  const { turn } = conversation;
  const deliver = (proposal: Proposal): void => {
    setTurn(setConversation, { tag: "confirming", value: proposal });
    acknowledge(proposal);
  };
  return {
    view: presentConversation(conversation),
    submit: (text): void => {
      if (!canSubmit(turn)) return;
      const decoded = Schema.decodeOption(HostedTurnRequest)({ text });
      if (Option.isNone(decoded)) {
        setTurn(setConversation, { tag: "error" });
        return;
      }
      const entry: Entry = {
        id: Effect.runSync(browserCrypto.randomUUIDv4.pipe(Effect.orDie)),
        from: "user",
        text: decoded.value.text,
      };
      const previous: ReadonlyArray<Entry> =
        turn.tag === "completed"
          ? [{ id: turn.value.turnId, from: "assistant", text: turn.value.text }]
          : [];
      setConversation((current) => ({
        turn: { tag: "waiting" },
        history: [...current.history, ...previous, entry].slice(-visibleHistoryLimit),
      }));
      propose({ payload: decoded.value, entryId: entry.id });
    },
    replyVisible: (): void => {
      if (turn.tag !== "proposal") return;
      if (
        Option.isSome(deliveredTurn.current) &&
        deliveredTurn.current.value === turn.value.turnId
      ) {
        return;
      }
      deliveredTurn.current = Option.some(turn.value.turnId);
      deliver(turn.value);
    },
    checkProgress: (): void => {
      if (turn.tag === "processing" || turn.tag === "uncertain") progress(turn.value);
    },
    retryDelivery: (): void => {
      if (turn.tag === "unconfirmed") deliver(turn.value);
    },
  };
};
