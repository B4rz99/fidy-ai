import { useAtomSet } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { Effect, Option, Schema } from "effect";
import type { Atom } from "effect/unstable/reactivity";
import { useState } from "react";
import type { JSX } from "react";
import { Button } from "@/ui/components/button";
import { HostedTurnRequest } from "@/transport/client";
import type {
  HostedTurnClient,
  HostedTurnProcessing,
  HostedTurnProposal,
  HostedTurnReceipt,
} from "@/transport/client";

type Proposal = typeof HostedTurnProposal.Type;
type Processing = typeof HostedTurnProcessing.Type;
type HostedReply = Proposal | Processing;
type TurnState =
  | Readonly<{ tag: "idle" | "waiting" | "error" }>
  | Readonly<{ tag: "proposal"; value: Proposal }>
  | Readonly<{ tag: "processing" | "uncertain"; value: Processing }>
  | Readonly<{ tag: "confirming" | "completed" | "unconfirmed"; text: string }>;

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
  proposal: "Respuesta visible. Confirma que la recibiste para completar el turno.",
  processing: "El turno sigue en curso. Consulta el estado antes de volver a intentarlo.",
  uncertain:
    "No se pudo recuperar el turno. Una operación podría haberse ejecutado: consulta tus datos antes de reintentar.",
  confirming: "Confirmando entrega…",
  completed: "Respuesta entregada.",
  unconfirmed: "La entrega no se pudo confirmar. La respuesta no se guardó como completada.",
};

const AgentReply = ({
  turn,
  onConfirm,
  onProgress,
}: Readonly<{
  turn: TurnState;
  onConfirm: (proposal: Proposal) => void;
  onProgress: (pending: Processing) => void;
}>): JSX.Element => {
  let reply: Option.Option<string> = Option.none();
  if (turn.tag === "proposal") reply = Option.some(turn.value.text);
  else if ("text" in turn) reply = Option.some(turn.text);
  return (
    <>
      {Option.isSome(reply) && (
        <section
          aria-label="Respuesta del agente"
          className="rounded-lg border bg-background p-4 whitespace-pre-wrap"
        >
          {reply.value}
        </section>
      )}
      <p aria-live="polite">{status[turn.tag]}</p>
      {(turn.tag === "processing" || turn.tag === "uncertain") && (
        <Button onClick={() => onProgress(turn.value)} type="button">
          Consultar estado
        </Button>
      )}
      {turn.tag === "proposal" && (
        <Button onClick={() => onConfirm(turn.value)} type="button">
          Confirmar recepción
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
    setTurn({ tag: "confirming", text: value.text });
    run({
      payload: { turnId: value.turnId, receipt: value.receipt },
      onCompleted: () => setTurn({ tag: "completed", text: value.text }),
      onFailed: () => setTurn({ tag: "unconfirmed", text: value.text }),
    });
  };

/** Human-visible, explicit receipt is the only path from proposed reply to Completed. */
export const HostedAgentFeature = (): JSX.Element => {
  const client = useRouter().options.context.hostedTurnClient;
  const [proposeAtom] = useState(() => proposeCommand(client));
  const [receiptAtom] = useState(() => receiptCommand(client));
  const [progressAtom] = useState(() => progressCommand(client));
  const propose = useAtomSet(proposeAtom);
  const acknowledge = useAtomSet(receiptAtom);
  const progress = useAtomSet(progressAtom);
  const [text, setText] = useState("");
  const [turn, setTurn] = useState<TurnState>({ tag: "idle" });
  const waiting =
    turn.tag === "waiting" ||
    turn.tag === "processing" ||
    turn.tag === "proposal" ||
    turn.tag === "confirming";
  const onSubmit = (event: React.SubmitEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (waiting) return;
    const decoded = Schema.decodeOption(HostedTurnRequest)({ text });
    if (Option.isNone(decoded)) {
      setTurn({ tag: "error" });
      return;
    }
    setTurn({ tag: "waiting" });
    propose({
      payload: decoded.value,
      onProposed: (value) => {
        setText("");
        setTurn("status" in value ? { tag: "processing", value } : { tag: "proposal", value });
      },
      onFailed: () => setTurn({ tag: "error" }),
    });
  };
  const onProgress = progressHandler(progress, setTurn);
  const onConfirm = receiptHandler(acknowledge, setTurn);
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 px-5 py-10">
      <h1 className="font-heading text-2xl font-semibold">Agente</h1>
      <p>
        Escribe un mensaje para conversar con el agente alojado. No compartas contraseñas, tokens,
        datos de tarjetas ni números de cuenta.
      </p>
      <AgentReply onConfirm={onConfirm} onProgress={onProgress} turn={turn} />
      <form className="flex flex-col gap-3" onSubmit={onSubmit}>
        <label htmlFor="hosted-message">Mensaje</label>
        <textarea
          id="hosted-message"
          className="min-h-32 rounded-md border bg-background p-3"
          disabled={waiting}
          onChange={(event) => setText(event.target.value)}
          required
          value={text}
        />
        <Button disabled={waiting} type="submit">
          Enviar
        </Button>
      </form>
    </main>
  );
};
