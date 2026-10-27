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
import { OAuthClient, OAuthNotice, OAuthState, OAuthWorkspace } from "@/ui/components/oauth-review";

import { formatExpiration } from "./expiration";

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
    return (
      <OAuthState title="Operación cancelada" kind="information">
        <p>No se ejecutó ningún cambio.</p>
      </OAuthState>
    );
  }
  if (state === "unknown") return <UnknownOperation />;
  if (result._tag === "Initial") {
    return (
      <OAuthState title="Consultando operación" kind="warning">
        <output>Cargando operación…</output>
      </OAuthState>
    );
  }
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
  return (
    <OAuthWorkspace title="Revisar operación">
      <OperationView review={review} disabled={state !== "ready"} submit={submit} />
    </OAuthWorkspace>
  );
};

export const OAuthOperationFeature = (): JSX.Element => {
  const params = useParams({ strict: false });
  const reference = Schema.decodeUnknownOption(OAuthRequestId)(params.reference);
  return Option.isSome(reference) ? (
    <OperationReview key={reference.value} reference={reference.value} />
  ) : (
    <OAuthState title="Referencia no válida" kind="warning">
      <p role="alert">La referencia no es válida.</p>
    </OAuthState>
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
  <div className="settings-columns">
    <div className="settings-main">
      <OAuthClient name={review.claimedClientName}>
        <p className="oauth-identity">
          <span>Conexión</span>
          <span>{review.connectionId}</span>
        </p>
        <section className="oauth-operation">
          <h3>Efectos de la operación</h3>
          <ul className="oauth-effects">
            {review.effects.map((effect, index) => (
              <li key={`${index}:${effect}`}>{effect}</li>
            ))}
          </ul>
          <p className="oauth-operation-name">
            <span className="oauth-description">Operación</span>
            <strong>{review.operation}</strong>
          </p>
          <h4>Entrada exacta</h4>
          <pre className="oauth-input">{review.inputJson}</pre>
        </section>
      </OAuthClient>
    </div>
    <aside className="settings-panel oauth-panel" aria-label="Antes de aprobar">
      <h2>Antes de aprobar</h2>
      <OAuthNotice kind="warning">
        Revisa todos los efectos y la entrada exacta. Aprueba solo si solicitaste esta operación.
      </OAuthNotice>
      <p className="oauth-expiration">
        <span className="oauth-description">Esta solicitud vence</span>
        <time dateTime={DateTime.formatIso(DateTime.makeUnsafe(review.expiresAtMilliseconds))}>
          {formatExpiration(DateTime.makeUnsafe(review.expiresAtMilliseconds))}
        </time>
      </p>
      <OAuthNotice kind="information">
        Aprobar permite continuar una sola vez desde tu agente. La operación no se ejecuta aquí.
      </OAuthNotice>
      <div className="oauth-actions">
        <Button disabled={disabled} onClick={() => submit("approve")}>
          Aprobar operación
        </Button>
        <Button variant="outline" disabled={disabled} onClick={() => submit("cancel")}>
          Cancelar operación
        </Button>
      </div>
    </aside>
  </div>
);
const UnknownOperation = (): JSX.Element => (
  <OAuthState title="Resultado por confirmar" kind="warning">
    <p role="alert">
      No pudimos confirmar el resultado. Recarga esta página para consultar el estado antes de
      continuar.
    </p>
  </OAuthState>
);
const ApprovedOperation = (): JSX.Element => (
  <OAuthState title="Aprobación registrada" kind="success">
    <p>
      Vuelve a tu agente para continuar antes de que venza. La operación aún no se ha ejecutado.
    </p>
  </OAuthState>
);
const UnavailableOperation = ({ reference }: Readonly<{ reference: string }>): JSX.Element => (
  <OAuthState title="Operación no disponible" kind="warning">
    <p role="alert">
      La operación venció, no está disponible o requiere un nuevo inicio de sesión.
    </p>
    <Button render={<Link to="/login" reloadDocument search={{ oauthOperation: reference }} />}>
      Iniciar sesión
    </Button>
  </OAuthState>
);
