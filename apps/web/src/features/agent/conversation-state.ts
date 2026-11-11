import { browserSecureRandom } from "@/browser/crypto";
import { type Context, Effect, Option, Schema } from "effect";
import type { Atom } from "effect/reactivity";
import { HostedTurnQuotaExceeded, HostedTurnRequest } from "@/transport/hosted-turn-client";
import type {
  HostedTurnClient,
  HostedTurnProcessing,
  HostedTurnProposal,
} from "@/transport/hosted-turn-client";

type Proposal = typeof HostedTurnProposal.Type;
type Processing = typeof HostedTurnProcessing.Type;
type Turn =
  | Readonly<{ tag: "idle" | "waiting" | "error" | "quota" }>
  | Readonly<{ tag: "proposal"; value: Proposal }>
  | Readonly<{ tag: "polling" | "processing" | "uncertain"; value: Processing }>
  | Readonly<{ tag: "confirming" | "completed" | "unconfirmed"; value: Proposal }>;
type Entry = Readonly<{ id: string; from: "user" | "assistant"; text: string }>;
export type Conversation = Readonly<{ turn: Turn; history: ReadonlyArray<Entry> }>;
export type SetConversation = (
  update: Conversation | ((previous: Conversation) => Conversation)
) => void;
const visibleHistoryLimit = 40;
export const initialConversation: Conversation = { turn: { tag: "idle" }, history: [] };

const status: Readonly<Record<Turn["tag"], string>> = {
  idle: "",
  waiting: "Esperando respuesta…",
  error: "No se pudo completar el turno. Inténtalo de nuevo.",
  quota:
    "El agente alcanzó su límite diario. Tu borrador sigue aquí. Inténtalo cuando se restablezca el acceso; si pediste cambios, revisa tus datos antes de reenviar.",
  proposal: "",
  polling: "Esperando respuesta…",
  processing: "El turno sigue en curso. Consulta el estado antes de volver a intentarlo.",
  uncertain:
    "No se pudo recuperar el turno. Una operación podría haberse ejecutado: consulta tus datos antes de reintentar.",
  confirming: "",
  completed: "",
  unconfirmed: "No pudimos guardar la respuesta. Reintenta la conexión para continuar.",
};
const proposedTurn = (value: Proposal | Processing): Turn =>
  "status" in value ? { tag: "processing", value } : { tag: "proposal", value };
const canSubmit = (turn: Turn): boolean =>
  ["idle", "error", "quota", "completed"].includes(turn.tag);
const setTurn = (setConversation: SetConversation, turn: Turn): void =>
  setConversation((previous) => ({ ...previous, turn }));

type Submission = Readonly<{ payload: typeof HostedTurnRequest.Type; entryId: string }>;
type Commands = Readonly<{
  propose: Atom.AtomResultFn<Submission, void, never>;
  progress: Atom.AtomResultFn<Processing, void, never>;
  receipt: Atom.AtomResultFn<Proposal, void, never>;
}>;
const rejectSubmission = (
  setConversation: SetConversation,
  entryId: string,
  failure: unknown
): Effect.Effect<void> =>
  Effect.sync(() =>
    setConversation((previous) => ({
      turn: { tag: Schema.is(HostedTurnQuotaExceeded)(failure) ? "quota" : "error" },
      history: previous.history.filter((entry) => entry.id !== entryId),
    }))
  );

type Channel = Context.Service.Shape<HostedTurnClient>;
const progressChecks = 12;
const retainUncertain = (setConversation: SetConversation, reply: Proposal | Processing): void => {
  if ("status" in reply) setTurn(setConversation, { tag: "uncertain", value: reply });
};
export type ConversationLifetime = Readonly<{
  setConversation: SetConversation;
  clearDraft: () => void;
  active: () => boolean;
}>;
const followTurn = (
  channel: Channel,
  initial: Proposal | Processing,
  { setConversation, active }: ConversationLifetime
): Effect.Effect<void> =>
  Effect.gen(function* () {
    let current = initial;
    for (let attempt = 0; "status" in current && attempt < progressChecks; attempt++) {
      if (!active()) return;
      const pending = current;
      yield* Effect.sync(() => setTurn(setConversation, { tag: "polling", value: pending }));
      yield* Effect.sleep("5 seconds");
      if (!active()) return;
      current = yield* channel.hostedTurn.progress({ payload: { turnId: current.turnId } });
    }
    yield* Effect.sync(() => setTurn(setConversation, proposedTurn(current)));
  }).pipe(Effect.catch(() => Effect.sync(() => retainUncertain(setConversation, initial))));

export const conversationCommands = ({
  client,
  capture,
}: Readonly<{
  client: HostedTurnClient;
  capture: () => ConversationLifetime;
}>): Commands => ({
  propose: client.runtime.fn<Submission>()(
    ({ payload, entryId }) => {
      const lifetime = capture();
      const { setConversation, clearDraft } = lifetime;
      return Effect.gen(function* () {
        const channel = yield* client;
        const reply = yield* channel.hostedTurn.propose({ payload });
        yield* Effect.sync(clearDraft);
        yield* followTurn(channel, reply, lifetime);
      }).pipe(Effect.catch((failure) => rejectSubmission(setConversation, entryId, failure)));
    },
    { concurrent: false }
  ),
  progress: client.runtime.fn<Processing>()(
    (pending) => {
      const { setConversation } = capture();
      return Effect.gen(function* () {
        const channel = yield* client;
        const reply = yield* channel.hostedTurn.progress({ payload: { turnId: pending.turnId } });
        yield* Effect.sync(() => setTurn(setConversation, proposedTurn(reply)));
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => setTurn(setConversation, { tag: "uncertain", value: pending }))
        )
      );
    },
    { concurrent: false }
  ),
  receipt: client.runtime.fn<Proposal>()(
    (proposal) => {
      const { setConversation } = capture();
      return Effect.gen(function* () {
        const channel = yield* client;
        yield* channel.hostedTurn.acknowledge({
          payload: { turnId: proposal.turnId, receipt: proposal.receipt },
        });
        yield* Effect.sync(() => setTurn(setConversation, { tag: "completed", value: proposal }));
      }).pipe(
        Effect.catch(() =>
          Effect.sync(() => setTurn(setConversation, { tag: "unconfirmed", value: proposal }))
        )
      );
    },
    { concurrent: false }
  ),
});

export type VisibleAgentReply = Readonly<{
  text: string;
  awaitingVisibility: boolean;
  id: string;
  onVisible: () => void;
  confirm: Option.Option<() => void>;
}>;
type ConversationView = Readonly<{
  history: ReadonlyArray<Entry>;
  reply: Option.Option<VisibleAgentReply>;
  status: string;
  statusKind: "waiting" | "warning" | "information";
  empty: boolean;
  canSubmit: boolean;
  canCheckProgress: boolean;
  canRetryDelivery: boolean;
}>;
const presentStatusKind = (tag: Turn["tag"]): ConversationView["statusKind"] => {
  if (tag === "waiting" || tag === "polling") return "waiting";
  if (tag === "uncertain" || tag === "processing" || tag === "error") return "warning";
  return "information";
};
export const presentConversation = (
  { turn, history }: Conversation,
  actions: Readonly<{ onVisible: () => void; confirm: () => void }>
): ConversationView => ({
  history,
  reply:
    "value" in turn && !("status" in turn.value)
      ? Option.some({
          text: turn.value.text,
          awaitingVisibility: turn.tag === "proposal",
          id: turn.value.turnId,
          onVisible: actions.onVisible,
          confirm:
            turn.value.confirmation === undefined ? Option.none() : Option.some(actions.confirm),
        })
      : Option.none(),
  status: status[turn.tag],
  statusKind: presentStatusKind(turn.tag),
  empty: history.length === 0 && turn.tag === "idle",
  canSubmit: canSubmit(turn),
  canCheckProgress: turn.tag === "processing" || turn.tag === "uncertain",
  canRetryDelivery: turn.tag === "unconfirmed",
});
export type HostedConversation = Readonly<{
  display: ConversationView;
  submit: (text: string) => void;
  checkProgress: () => void;
  retryDelivery: () => void;
}>;

const submitConversation = ({
  text,
  displayText,
  turn,
  setConversation,
  propose,
}: Readonly<{
  text: string;
  displayText: string;
  turn: Turn;
  setConversation: SetConversation;
  propose: (submission: Submission) => void;
}>): void => {
  if (!canSubmit(turn)) return;
  const decoded = Schema.decodeOption(HostedTurnRequest)({ text });
  if (Option.isNone(decoded)) {
    setTurn(setConversation, { tag: "error" });
    return;
  }
  const entry: Entry = {
    id: Effect.runSync(browserSecureRandom.uuidV4().pipe(Effect.orDie)),
    from: "user",
    text: displayText,
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
};

export const presentHostedConversation = ({
  conversation,
  setConversation,
  propose,
  progress,
  acknowledge,
  current,
  active,
}: Readonly<{
  conversation: Conversation;
  setConversation: SetConversation;
  propose: (submission: Submission) => void;
  progress: (pending: Processing) => void;
  acknowledge: (proposal: Proposal) => void;
  current: () => Conversation;
  active: () => boolean;
}>): HostedConversation => {
  const { turn } = conversation;
  const isCurrent = (): boolean => active() && current().turn === turn;
  const deliver = (proposal: Proposal): void => {
    setTurn(setConversation, { tag: "confirming", value: proposal });
    acknowledge(proposal);
  };
  const confirm = (): void => {
    if (!isCurrent() || turn.tag !== "completed" || turn.value.confirmation === undefined) return;
    submitConversation({
      text: turn.value.confirmation.command,
      displayText: "Confirmar cambio",
      turn,
      setConversation,
      propose,
    });
  };
  const onVisible = (): void => {
    if (isCurrent() && turn.tag === "proposal") deliver(turn.value);
  };
  return {
    display: presentConversation(conversation, { onVisible, confirm }),
    submit: (text): void => {
      if (isCurrent()) {
        submitConversation({ text, displayText: text, turn, setConversation, propose });
      }
    },
    checkProgress: (): void => {
      if (!isCurrent() || (turn.tag !== "processing" && turn.tag !== "uncertain")) return;
      setTurn(setConversation, { tag: "polling", value: turn.value });
      progress(turn.value);
    },
    retryDelivery: (): void => {
      if (isCurrent() && turn.tag === "unconfirmed") deliver(turn.value);
    },
  };
};
