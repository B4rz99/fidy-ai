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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/components/card";
import { ManagementPage } from "./management-feature";
import { OAuthReviewView } from "./view";

/** Session-registry-owned metadata and commands; URL pagination contains only public connection references. */
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
  <Card className="max-w-md">
    <CardHeader>
      <CardTitle>Solicitud no disponible</CardTitle>
      <CardDescription>
        Puede haber vencido o requerir un nuevo inicio de sesión. No se autorizó ningún acceso.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <Button render={<Link to="/auth/pair" search={{ oauthRequest: requestId }} />}>
        Iniciar sesión
      </Button>
    </CardContent>
  </Card>
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
  if (cancelled) return <output>Solicitud cancelada. No se autorizó ningún acceso.</output>;
  if (result._tag === "Initial") return <output>Cargando solicitud…</output>;
  if (result._tag === "Failure") return <ReviewUnavailable requestId={requestId} />;
  return (
    <div className="flex flex-col gap-3">
      {connectFailed ? (
        <p role="alert">
          No pudimos confirmar el resultado. Inicia una nueva conexión desde tu agente; no repitas
          esta aprobación.
        </p>
      ) : null}
      {cancelFailed ? (
        <p role="alert">No pudimos cancelar. Intenta de nuevo; no se autorizó ningún acceso.</p>
      ) : null}
      <OAuthReviewView
        key={result.value.requestId}
        review={result.value}
        cancelling={cancelling}
        cancel={cancel}
        connecting={connecting || connectFailed}
        connect={connect}
      />
    </div>
  );
};
/** Public references identify only a fresh-session review, never a credential or post-login destination. */
export const OAuthReviewFeature = (): JSX.Element => {
  const params = useParams({ strict: false });
  const requestId = Schema.decodeUnknownOption(OAuthRequestId)(params.requestId);
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 px-4 py-12">
      {Option.isSome(requestId) ? (
        <ReviewContent key={requestId.value} requestId={requestId.value} />
      ) : (
        <p role="alert">La solicitud no es válida.</p>
      )}
    </main>
  );
};
