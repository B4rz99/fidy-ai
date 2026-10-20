import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useParams, useRouter } from "@tanstack/react-router";
import type { Atom } from "effect/reactivity";
import { DateTime, Effect, Option, Schema } from "effect";
import { type JSX, useState } from "react";
import {
  type OAuthOperationDecision,
  type OAuthOperationReview,
  OAuthRequestId,
  type WebAuthClient,
} from "@/transport/client";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";

type DecisionCommand = Readonly<{
  choice: typeof OAuthOperationDecision.Type;
  completed: () => void;
  failed: () => void;
}>;
const makeDecision = (client: WebAuthClient): Atom.AtomResultFn<DecisionCommand, void, never> =>
  client.runtime.fn<DecisionCommand>()(
    (command) =>
      client.pipe(
        Effect.flatMap((api) => api.oauthReview.operationDecision({ payload: command.choice })),
        Effect.tap(() => Effect.sync(command.completed)),
        Effect.asVoid,
        Effect.catchCause(() => Effect.sync(command.failed))
      ),
    { concurrent: false }
  );
const OperationReview = ({ reference }: Readonly<{ reference: string }>): JSX.Element => {
  const router = useRouter();
  const client = router.options.context.webAuthClient;
  const [query] = useState(() =>
    client.query("oauthReview", "operationReview", {
      query: { reference },
      timeToLive: "0 seconds",
    })
  );
  const queried = useAtomValue(query);
  const result = presentCanonicalQuery(queried);
  const [decisionAtom] = useState(() => makeDecision(client));
  const decide = useAtomSet(decisionAtom);
  const [state, setState] = useState<"ready" | "sending" | "approved" | "cancelled" | "unknown">(
    "ready"
  );
  if (state === "approved") return <ApprovedOperation />;
  if (state === "cancelled") {
    return <output>Operación cancelada. No se ejecutó ningún cambio.</output>;
  }
  if (state === "unknown") {
    return (
      <p role="alert">
        No pudimos confirmar el resultado. Recarga esta página para consultar el estado antes de
        continuar.
      </p>
    );
  }
  if (result._tag === "Initial") return <output>Cargando operación…</output>;
  if (result._tag === "Failure") return <UnavailableOperation reference={reference} />;
  const review = result.value;
  if (review.approved) return <ApprovedOperation />;
  const submit = (decision: "approve" | "cancel"): void => {
    setState("sending");
    decide({
      choice: {
        reference: review.reference,
        inputDigest: review.inputDigest,
        disclosureRevision: review.disclosureRevision,
        decision,
      },
      completed: () => setState(decision === "approve" ? "approved" : "cancelled"),
      failed: () => setState("unknown"),
    });
  };
  return <OperationView review={review} disabled={state !== "ready"} submit={submit} />;
};

export const OAuthOperationFeature = (): JSX.Element => {
  const params = useParams({ strict: false });
  const reference = Schema.decodeUnknownOption(OAuthRequestId)(params.reference);
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 px-4 py-12">
      {Option.isSome(reference) ? (
        <OperationReview key={reference.value} reference={reference.value} />
      ) : (
        <p role="alert">La referencia no es válida.</p>
      )}
    </main>
  );
};

const OperationView = ({
  review,
  disabled,
  submit,
}: Readonly<{
  review: OAuthOperationReview;
  disabled: boolean;
  submit: (decision: "approve" | "cancel") => void;
}>): JSX.Element => (
  <section className="flex w-full max-w-2xl flex-col gap-4">
    <h1 className="text-2xl font-semibold">Revisar operación del agente</h1>
    <p>Cliente (nombre declarado): {review.claimedClientName}</p>
    <p>Conexión: {review.connectionId}</p>
    <p>Revisa todos los efectos y la entrada exacta. Aprueba solo si solicitaste esta operación.</p>
    <ul>
      {review.effects.map((effect, index) => (
        <li key={`${index}:${effect}`}>{effect}</li>
      ))}
    </ul>
    <p>Operación: {review.operation}</p>
    <pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded border p-3">
      {review.inputJson}
    </pre>
    <p>
      Vence: {DateTime.formatIso(DateTime.makeUnsafe(review.expiresAtMilliseconds))}. Aprobar
      permite continuar una sola vez desde tu agente.
    </p>
    <div className="flex gap-3">
      <Button disabled={disabled} onClick={() => submit("approve")}>
        Aprobar operación
      </Button>
      <Button variant="outline" disabled={disabled} onClick={() => submit("cancel")}>
        Cancelar operación
      </Button>
    </div>
  </section>
);
const ApprovedOperation = (): JSX.Element => (
  <output>
    Aprobación registrada. Vuelve a tu agente para continuar antes de que venza. La operación aún no
    se ha ejecutado.
  </output>
);
const UnavailableOperation = ({ reference }: Readonly<{ reference: string }>): JSX.Element => (
  <div>
    <p role="alert">
      La operación venció, no está disponible o requiere un nuevo inicio de sesión.
    </p>
    <Button render={<Link to="/login" reloadDocument search={{ oauthOperation: reference }} />}>
      Iniciar sesión
    </Button>
  </div>
);
