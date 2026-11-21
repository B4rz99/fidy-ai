import { PendingRead } from "@/ui/components/pending-read";

import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useParams, useRouter, useSearch } from "@tanstack/react-router";
import { type Data, Option, Predicate, Schema } from "effect";
import { type JSX, type RefCallback, useCallback, useState } from "react";
import { OAuthRequestId, type OAuthReview, type WebAuthClient } from "@/transport/client";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import { OAuthState, OAuthWorkspace } from "@/ui/components/oauth-review";
import { ManagementPage } from "./management-feature";
import { OAuthReviewView } from "./view";
import { ReviewTaskState, initialReviewSelection, openReviewTask } from "./review-task";

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

  if (Predicate.isTagged(result, "Initial")) return <LoadingRequest />;

  if (Predicate.isTagged(result, "Failure") || Option.isSome(result.refreshFailure)) {
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
    openReviewTask({
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
  state: Data.TaggedEnum.Value<
    ReviewTaskState,
    "Loading" | "Unavailable" | "CancellationUnconfirmed"
  >;
  readAgain: () => void;
}>): JSX.Element => (
  <OAuthState
    title={
      ReviewTaskState.$is("Unavailable")(state)
        ? "Solicitud no disponible"
        : "Cancelación sin confirmar"
    }
    kind="warning"
  >
    <p role="alert">No pudimos confirmar la cancelación de esta solicitud.</p>
    {ReviewTaskState.$is("Loading")(state) ? (
      <PendingRead label="Cargando solicitud" />
    ) : (
      <>
        {ReviewTaskState.$is("Unavailable")(state) && (
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
  actions: ReturnType<ReturnType<typeof openReviewTask>["actions"]>;
}>): JSX.Element => {
  const recovery = (
    recovering: Data.TaggedEnum.Value<
      ReviewTaskState,
      "Loading" | "Unavailable" | "CancellationUnconfirmed"
    >
  ): JSX.Element => <CancellationRecovery state={recovering} readAgain={actions.readAgain} />;

  const workspace = (
    selection: Data.TaggedEnum.Value<ReviewTaskState, "Reviewing" | "Connecting" | "Cancelling">
  ): JSX.Element => (
    <OAuthWorkspace title="Conectar con Fidy">
      <OAuthReviewView
        review={selection.review}
        scopes={selection.scopes}
        days={selection.days}
        {...actions}
        connecting={ReviewTaskState.$is("Connecting")(selection)}
        cancelling={ReviewTaskState.$is("Cancelling")(selection)}
      />
    </OAuthWorkspace>
  );

  return ReviewTaskState.$match(state, {
    Cancelled: () => <CancelledRequest />,
    Disposed: () => (
      <OAuthState title="Solicitud no disponible" kind="warning">
        <p>Saliste de esta revisión. Si enviaste una decisión, todavía puede completarse.</p>
      </OAuthState>
    ),
    Uncertain: () => (
      <OAuthState title="Conexión sin confirmar" kind="warning">
        <p role="alert">
          No pudimos confirmar el resultado. Inicia una nueva conexión desde tu agente; no repitas
          esta aprobación.
        </p>
      </OAuthState>
    ),
    Redirecting: () => (
      <OAuthState title="Volviendo a tu agente" kind="information">
        <p>La aprobación se confirmó. Continúa en tu agente para completar la conexión.</p>
      </OAuthState>
    ),
    CancellationUnconfirmed: recovery,
    Loading: recovery,
    Unavailable: recovery,
    Reviewing: workspace,
    Connecting: workspace,
    Cancelling: workspace,
  });
};

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
