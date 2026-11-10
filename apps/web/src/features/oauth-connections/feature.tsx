import { PendingRead } from "@/ui/components/pending-read";

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useParams, useRouter, useSearch } from "@tanstack/react-router";
import { Option, Schema } from "effect";
import { type JSX, type RefCallback, useCallback, useState } from "react";
import { OAuthRequestId, type OAuthReview, type WebAuthClient } from "@/transport/client";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import { OAuthState, OAuthWorkspace } from "@/ui/components/oauth-review";
import { ManagementPage } from "./management-feature";
import { OAuthReviewView } from "./view";
import { type ReviewTaskState, initialReviewSelection, makeReviewTask } from "./review-task";

export const OAuthManagementFeature = (): JSX.Element => {
  const search = useSearch({ strict: false });
  const after = Option.fromUndefinedOr(search.after);
  return <ManagementPage key={Option.getOrElse(after, () => "first")} after={after} />;
};
const ReviewUnavailable = ({ requestId }: Readonly<{ requestId: string }>): JSX.Element => (
  <OAuthState title="Solicitud no disponible" kind="warning">
    <p>
      Puede haber vencido, haberse utilizado o requerir un nuevo inicio de sesión. No pudimos
      comprobar el estado de esta solicitud.
    </p>
    <Button render={<Link to="/login" reloadDocument search={{ oauthRequest: requestId }} />}>
      Iniciar sesión
    </Button>
  </OAuthState>
);
const useReviewedRequest = (
  client: WebAuthClient,
  requestId: string
): CanonicalQueryState<OAuthReview, unknown> => {
  const [query] = useState(() =>
    client.query("oauthReview", "review", { query: { requestId }, timeToLive: "0 seconds" })
  );
  const result = useAtomValue(query);
  return presentCanonicalQuery(result);
};
const CancelledRequest = (): JSX.Element => (
  <OAuthState title="Solicitud cancelada" kind="information">
    <p>No se autorizó ningún acceso.</p>
  </OAuthState>
);
const LoadingRequest = (): JSX.Element => (
  <OAuthWorkspace title="Conectar con Fidy">
    <PendingRead label="Cargando solicitud" />
  </OAuthWorkspace>
);
const ReviewContent = ({ requestId }: Readonly<{ requestId: string }>): JSX.Element => {
  const router = useRouter();
  const result = useReviewedRequest(router.options.context.webAuthClient, requestId);
  if (result._tag === "Initial") return <LoadingRequest />;
  if (result._tag === "Failure" || Option.isSome(result.refreshFailure)) {
    return <ReviewUnavailable requestId={requestId} />;
  }
  if (result.waiting) return <LoadingRequest />;
  return (
    <MountedReviewTask
      key={result.value.requestId}
      review={result.value}
      client={router.options.context.webAuthClient}
    />
  );
};
const MountedReviewTask = ({
  review,
  client,
}: Readonly<{ review: OAuthReview; client: WebAuthClient }>): JSX.Element => {
  const [initial] = useState(() => initialReviewSelection(review));
  const [state, setState] = useState<ReviewTaskState>(initial);
  const [task] = useState(() =>
    makeReviewTask({
      client,
      initial,
      onChange: setState,
      navigate: (callback): void => window.location.assign(callback),
    })
  );
  const dispatch = useAtomSet(task.atom);
  const lifecycleRef = useCallback<RefCallback<HTMLDivElement>>(
    (node) => {
      if (node === null) return;
      return task.mount();
    },
    [task]
  );
  const actions = task.actions(state, dispatch);
  return (
    <div ref={lifecycleRef}>
      <ReviewTaskContent state={state} actions={actions} />
    </div>
  );
};
const CancellationRecovery = ({
  state,
  readAgain,
}: Readonly<{
  state: Extract<ReviewTaskState, { _tag: "Loading" | "Unavailable" | "CancellationUnconfirmed" }>;
  readAgain: () => void;
}>): JSX.Element => (
  <OAuthState
    title={state._tag === "Unavailable" ? "Solicitud no disponible" : "Cancelación sin confirmar"}
    kind="warning"
  >
    <p role="alert">No pudimos confirmar la cancelación de esta solicitud.</p>
    {state._tag === "Loading" ? (
      <PendingRead label="Cargando solicitud" />
    ) : (
      <>
        {state._tag === "Unavailable" && (
          <p>No pudimos comprobar si esta solicitud sigue disponible.</p>
        )}
        <Button onClick={readAgain}>Volver a leer la solicitud</Button>
      </>
    )}
  </OAuthState>
);

const ReviewTaskContent = ({
  state,
  actions,
}: Readonly<{
  state: ReviewTaskState;
  actions: ReturnType<ReturnType<typeof makeReviewTask>["actions"]>;
}>): JSX.Element => {
  if (state._tag === "Cancelled") return <CancelledRequest />;
  if (state._tag === "Disposed") {
    return (
      <OAuthState title="Solicitud no disponible" kind="warning">
        <p>Saliste de esta revisión. Si enviaste una decisión, todavía puede completarse.</p>
      </OAuthState>
    );
  }
  if (state._tag === "Uncertain") {
    return (
      <OAuthState title="Conexión sin confirmar" kind="warning">
        <p role="alert">
          No pudimos confirmar el resultado. Inicia una nueva conexión desde tu agente; no repitas
          esta aprobación.
        </p>
      </OAuthState>
    );
  }
  if (state._tag === "Redirecting") {
    return (
      <OAuthState title="Volviendo a tu agente" kind="information">
        <p>La aprobación se confirmó. Continúa en tu agente para completar la conexión.</p>
      </OAuthState>
    );
  }
  if (
    state._tag === "CancellationUnconfirmed" ||
    state._tag === "Loading" ||
    state._tag === "Unavailable"
  ) {
    return <CancellationRecovery state={state} readAgain={actions.readAgain} />;
  }
  return (
    <OAuthWorkspace title="Conectar con Fidy">
      <OAuthReviewView
        review={state.review}
        scopes={state.scopes}
        days={state.days}
        {...actions}
        connecting={state._tag === "Connecting"}
        cancelling={state._tag === "Cancelling"}
      />
    </OAuthWorkspace>
  );
};
/** Public references grant no authority and select no post-login destination. */
export const OAuthReviewFeature = (): JSX.Element => {
  const params = useParams({ strict: false });
  const requestId = Schema.decodeUnknownOption(OAuthRequestId)(params.requestId);
  return Option.isSome(requestId) ? (
    <ReviewContent key={requestId.value} requestId={requestId.value} />
  ) : (
    <OAuthState title="Solicitud no válida" kind="warning">
      <p role="alert">La solicitud no es válida.</p>
    </OAuthState>
  );
};
