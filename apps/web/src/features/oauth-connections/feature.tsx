import { AuthorizationSkeleton } from "@/ui/components/authorization-loading";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useParams, useRouter, useSearch } from "@tanstack/react-router";
import { Effect, Option, Schema } from "effect";
import type { Atom } from "effect/reactivity";
import { type JSX, useState } from "react";
import {
  OAuthRequestId,
  type OAuthReview,
  type OAuthReviewChoice,
  type WebAuthClient,
} from "@/transport/client";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import { OAuthState, OAuthWorkspace } from "@/ui/components/oauth-review";
import { ManagementPage } from "./management-feature";
import { OAuthReviewView } from "./view";

export const OAuthManagementFeature = (): JSX.Element => {
  const search = useSearch({ strict: false });
  const after = Option.fromUndefinedOr(search.after);
  return <ManagementPage key={Option.getOrElse(after, () => "first")} after={after} />;
};
type CancelCommand = Readonly<{
  requestId: string;
  completed: () => void;
  failed: () => void;
  settled: () => void;
}>;
const makeCancel = (client: WebAuthClient): Atom.AtomResultFn<CancelCommand, void, never> =>
  client.runtime.fn<CancelCommand>()(
    (command) =>
      client.pipe(
        Effect.flatMap((api) =>
          api.oauthReview.cancel({ payload: { requestId: command.requestId } })
        ),
        Effect.tap(() => Effect.sync(command.completed)),
        Effect.asVoid,
        Effect.catchCause(() => Effect.sync(command.failed)),
        Effect.ensuring(Effect.sync(command.settled))
      ),
    { concurrent: false }
  );
type ConnectCommand = Readonly<{
  choice: OAuthReviewChoice;
  failed: () => void;
  settled: () => void;
}>;
const makeConnect = (client: WebAuthClient): Atom.AtomResultFn<ConnectCommand, void, never> =>
  client.runtime.fn<ConnectCommand>()(
    (command) =>
      client.pipe(
        Effect.flatMap((api) => api.oauthReview.connect({ payload: command.choice })),
        Effect.tap((connected) => Effect.sync(() => window.location.assign(connected.callback))),
        Effect.asVoid,
        Effect.catchCause(() => Effect.sync(command.failed)),
        Effect.ensuring(Effect.sync(command.settled))
      ),
    { concurrent: false }
  );
const ReviewUnavailable = ({ requestId }: Readonly<{ requestId: string }>): JSX.Element => (
  <OAuthState title="Solicitud no disponible" kind="warning">
    <p>Puede haber vencido o requerir un nuevo inicio de sesión. No se autorizó ningún acceso.</p>
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
    <AuthorizationSkeleton />
  </OAuthWorkspace>
);
const ReviewContent = ({ requestId }: Readonly<{ requestId: string }>): JSX.Element => {
  const router = useRouter();
  const result = useReviewedRequest(router.options.context.webAuthClient, requestId);
  const [cancelled, setCancelled] = useState(false);
  const [cancelFailed, setCancelFailed] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [cancelAtom] = useState(() => makeCancel(router.options.context.webAuthClient));
  const runCancel = useAtomSet(cancelAtom);
  const [connectAtom] = useState(() => makeConnect(router.options.context.webAuthClient));
  const runConnect = useAtomSet(connectAtom);
  const [connecting, setConnecting] = useState(false);
  const [connectFailed, setConnectFailed] = useState(false);
  const connect = (choice: OAuthReviewChoice): void => {
    setConnecting(true);
    setConnectFailed(false);
    runConnect({
      choice,
      failed: () => setConnectFailed(true),
      settled: () => setConnecting(false),
    });
  };
  const cancel = (): void => {
    setCancelling(true);
    setCancelFailed(false);
    runCancel({
      requestId,
      completed: () => setCancelled(true),
      failed: () => setCancelFailed(true),
      settled: () => setCancelling(false),
    });
  };
  if (cancelled) return <CancelledRequest />;
  if (result._tag === "Initial") return <LoadingRequest />;
  if (result._tag === "Failure") return <ReviewUnavailable requestId={requestId} />;
  if (connectFailed) {
    return (
      <OAuthState title="Conexión sin confirmar" kind="warning">
        <p role="alert">
          No pudimos confirmar el resultado. Inicia una nueva conexión desde tu agente; no repitas
          esta aprobación.
        </p>
      </OAuthState>
    );
  }
  return (
    <OAuthWorkspace title="Conectar con Fidy">
      <OAuthReviewView
        key={result.value.requestId}
        review={result.value}
        cancelling={cancelling}
        cancelFailed={cancelFailed}
        cancel={cancel}
        connecting={connecting}
        connect={connect}
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
