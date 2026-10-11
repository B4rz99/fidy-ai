import { Effect, Option, Schema } from "effect";
import { browserCrypto } from "@/browser/crypto";
import {
  type HostedTurnClient,
  type HostedTurnProcessing,
  type HostedTurnProposal,
  HostedTurnRequest,
} from "@/transport/client";
import type { Action, ConversationView } from "./model";

type Proposal = typeof HostedTurnProposal.Type;
type Processing = typeof HostedTurnProcessing.Type;
type Turn =
  | Readonly<{ tag: "idle" | "waiting" | "error" }>
  | Readonly<{ tag: "proposal" | "confirming" | "completed" | "unconfirmed"; value: Proposal }>
  | Readonly<{ tag: "processing" | "uncertain"; value: Processing }>;
type Entry = ConversationView["history"][number];
const historyLimit = 40;
const statuses: Readonly<Record<Turn["tag"], string>> = {
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
const canSubmit = (turn: Turn): boolean => ["idle", "error", "completed"].includes(turn.tag);
const proposed = (value: Proposal | Processing): Turn =>
  "status" in value ? { tag: "processing", value } : { tag: "proposal", value };
const presentation = ({ turn, history, busy, draft }: State): ConversationView => ({
  history,
  reply:
    "value" in turn && !("status" in turn.value)
      ? Option.some({ text: turn.value.text, awaitingVisibility: turn.tag === "proposal" })
      : Option.none(),
  status: statuses[turn.tag],
  hasDraft: draft.trim().length > 0,
  empty: history.length === 0 && turn.tag === "idle",
  canSubmit: !busy && canSubmit(turn),
  canCheckProgress: !busy && (turn.tag === "processing" || turn.tag === "uncertain"),
  canRetryDelivery: !busy && turn.tag === "unconfirmed",
});
export type ConversationController = Readonly<{
  initial: ConversationView;
  edit: (value: string) => void;
  mountInput: (input: HTMLTextAreaElement) => () => void;
  run: (action: Action) => Effect.Effect<void>;
  dispose: () => void;
}>;
type State = {
  active: boolean;
  busy: boolean;
  turn: Turn;
  history: ReadonlyArray<Entry>;
  draft: string;
  inputs: Set<HTMLTextAreaElement>;
  notify: () => void;
};
const clearDraft = (state: State): void => {
  state.draft = "";
  for (const input of state.inputs) input.value = "";
};
const propose = (state: State, client: HostedTurnClient): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (!canSubmit(state.turn)) return;
    const payload = Schema.decodeOption(HostedTurnRequest)({ text: state.draft });
    if (Option.isNone(payload)) {
      state.turn = { tag: "error" };
      return;
    }
    const entryId = yield* browserCrypto.randomUUIDv4.pipe(Effect.orDie);
    const previous: ReadonlyArray<Entry> =
      state.turn.tag === "completed"
        ? [{ id: state.turn.value.turnId, from: "assistant", text: state.turn.value.text }]
        : [];
    state.history = [
      ...state.history,
      ...previous,
      { id: entryId, from: "user" as const, text: payload.value.text },
    ].slice(-historyLimit);
    state.turn = { tag: "waiting" };
    state.notify();
    const channel = yield* client;
    yield* channel.hostedTurn.propose({ payload: payload.value }).pipe(
      Effect.match({
        onSuccess: (reply) => {
          if (state.active) {
            clearDraft(state);
            state.turn = proposed(reply);
          }
        },
        onFailure: () => {
          if (state.active) {
            state.turn = { tag: "error" };
            state.history = state.history.filter((entry) => entry.id !== entryId);
          }
        },
      })
    );
  });
const progress = (state: State, client: HostedTurnClient): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (state.turn.tag !== "processing" && state.turn.tag !== "uncertain") return;
    const pending = state.turn.value;
    const channel = yield* client;
    yield* channel.hostedTurn.progress({ payload: { turnId: pending.turnId } }).pipe(
      Effect.match({
        onSuccess: (reply) => {
          if (state.active) state.turn = proposed(reply);
        },
        onFailure: () => {
          if (state.active) state.turn = { tag: "uncertain", value: pending };
        },
      })
    );
  });
const acknowledge = (state: State, client: HostedTurnClient, retry: boolean): Effect.Effect<void> =>
  Effect.gen(function* () {
    if (state.turn.tag !== (retry ? "unconfirmed" : "proposal")) return;
    const proposal = state.turn.value;
    state.turn = { tag: "confirming", value: proposal };
    state.notify();
    const channel = yield* client;
    yield* channel.hostedTurn
      .acknowledge({ payload: { turnId: proposal.turnId, receipt: proposal.receipt } })
      .pipe(
        Effect.match({
          onSuccess: () => {
            if (state.active) state.turn = { tag: "completed", value: proposal };
          },
          onFailure: () => {
            if (state.active) state.turn = { tag: "unconfirmed", value: proposal };
          },
        })
      );
  });
const operation = (state: State, client: HostedTurnClient, action: Action): Effect.Effect<void> => {
  if (action === "Submit") return propose(state, client);
  if (action === "Progress") return progress(state, client);
  return acknowledge(state, client, action === "Retry");
};
/** Retains exact reply receipts privately until delivery; only public presentation leaves the owner. */
export const makeConversationController = ({
  client,
  changed,
}: Readonly<{
  client: HostedTurnClient;
  changed: (view: ConversationView) => void;
}>): ConversationController => {
  const state: State = {
    active: true,
    busy: false,
    turn: { tag: "idle" },
    history: [],
    draft: "",
    inputs: new Set(),
    notify: () => {
      if (state.active) changed(presentation(state));
    },
  };
  return {
    initial: presentation(state),
    edit: (value) => {
      if (state.active) state.draft = value;
    },
    mountInput: (input) => {
      state.inputs.add(input);
      input.value = state.draft;
      return () => {
        state.inputs.delete(input);
        input.value = "";
      };
    },
    run: (action) =>
      Effect.gen(function* () {
        if (!state.active || state.busy) return;
        state.busy = true;
        state.notify();
        yield* operation(state, client, action).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              state.busy = false;
              state.notify();
            })
          )
        );
      }),
    dispose: () => {
      state.active = false;
      clearDraft(state);
      state.inputs.clear();
      state.history = [];
      state.turn = { tag: "idle" };
    },
  };
};
