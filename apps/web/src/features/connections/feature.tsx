import { PendingRead } from "@/ui/components/pending-read";

import { ConnectionResult } from "./result";
import { continuationDeadline, useContinuation } from "./continuation";
import { ConnectionRecovery } from "@/ui/components/connection-recovery";
import { useSession } from "@/session/session-context";
import { WorkspaceHeader } from "@/ui/components/workspace-layout";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Link, useRouter, useSearch } from "@tanstack/react-router";
import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { Atom } from "effect/reactivity";
import { type JSX, type MouseEvent, useState } from "react";
import { ConnectionAttemptReference, type ConnectionContinuationReview } from "@/transport/client";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import { buttonVariants } from "@/ui/components/button-variants";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/components/card";

type AttemptReference = typeof ConnectionAttemptReference.Type;
const expirationFormatter = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "medium",
  timeStyle: "short",
  timeZone: "America/Bogota",
});

const preparationMessage: Readonly<
  Record<(typeof ConnectionContinuationReview.Type)["phase"], string>
> = {
  ready:
    "Prepararemos la solicitud. Después podrás revisar y decidir qué autorizas directamente en Bancolombia.",
  preparing: "Estamos preparando la autorización. Consulta el estado; no repitas la solicitud.",
  prepared: "La conexión sigue pendiente. Solo Bancolombia puede confirmar tu autorización.",
  failed:
    "No pudimos completar esta solicitud. Inicia una nueva conexión; esta solicitud no se volverá a enviar.",
};

const Unavailable = ({ attempt }: Readonly<{ attempt: AttemptReference }>): JSX.Element => (
  <Card className="w-full max-w-md">
    <CardHeader>
      <CardTitle>Solicitud no disponible</CardTitle>
      <CardDescription>
        Puede haber vencido o pertenecer a otra cuenta de Fidy. Inicia sesión con la cuenta que
        solicitó la conexión; si sigue sin estar disponible, inicia una nueva conexión.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <Button render={<Link to="/login" reloadDocument search={{ connectionAttempt: attempt }} />}>
        Iniciar sesión
      </Button>
    </CardContent>
  </Card>
);
const BankHandoff = ({
  review,
  disabled,
  canFollow,
}: Readonly<{
  review: typeof ConnectionContinuationReview.Type;
  disabled: boolean;
  canFollow: () => boolean;
}>): JSX.Element => {
  if (disabled || review.authorization === undefined) return <></>;
  const follow = (event: MouseEvent<HTMLAnchorElement>): void => {
    if (!canFollow()) event.preventDefault();
  };
  return (
    <a
      className={buttonVariants()}
      href={review.authorization.url}
      rel="noreferrer"
      onClick={follow}
      onAuxClick={follow}
      onContextMenu={follow}
    >
      Continuar en Bancolombia
    </a>
  );
};
const useExpiry = (
  expiresAt: DateTime.Utc
): Readonly<{ expired: boolean; check: () => boolean }> => {
  const { webAuthClient: client, registry } = useRouter().options.context;
  const [expiry] = useState(() => {
    const timer = client.runtime.atom(
      Effect.gen(function* () {
        const current = yield* Clock.currentTimeMillis;
        yield* Effect.sleep(Math.max(0, expiresAt.epochMilliseconds - current));
        return true;
      })
    );
    return Atom.writable(
      (get) =>
        get(timer).pipe(presentCanonicalQuery)._tag === "Ready" ||
        expiresAt.epochMilliseconds <= Effect.runSync(Clock.currentTimeMillis),
      (context, _value: void) => context.setSelf(true)
    );
  });
  return {
    expired: useAtomValue(expiry),
    check: () => {
      if (expiresAt.epochMilliseconds > Effect.runSync(Clock.currentTimeMillis)) return true;
      registry.set(expiry, undefined);
      return false;
    },
  };
};
const ExpiringReview = ({
  review,
  busy,
  blocked,
  expired,
  begin,
  canFollow,
}: Readonly<{
  review: typeof ConnectionContinuationReview.Type;
  busy: boolean;
  blocked: boolean;
  expired: boolean;
  begin: () => void;
  canFollow: () => boolean;
}>): JSX.Element => {
  const expiresAt = continuationDeadline(review);
  const disabled = busy || blocked || expired;
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>
          <h1>
            {review.phase === "prepared"
              ? "Conexión pendiente de autorización"
              : `Conectar ${review.institutionName}`}
          </h1>
        </CardTitle>
        <CardDescription>{preparationMessage[review.phase]}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p>No compartas claves bancarias, documentos de identidad ni números de cuenta en Fidy.</p>
        <p>
          Esta solicitud vence:{" "}
          <time dateTime={DateTime.formatIso(expiresAt)}>
            {expirationFormatter.format(DateTime.toDate(expiresAt))}
          </time>
          .
        </p>
        {expired ? <p role="alert">La solicitud venció. Inicia una nueva conexión.</p> : null}
        {review.phase === "ready" ? (
          <Button disabled={disabled} onClick={begin}>
            {busy ? "Continuando…" : "Continuar"}
          </Button>
        ) : null}
        <BankHandoff review={review} disabled={disabled} canFollow={canFollow} />
        <Button variant="outline" render={<Link to="/app/transactions" />}>
          Cancelar y volver a Fidy
        </Button>
      </CardContent>
    </Card>
  );
};
const ReviewNotices = ({
  uncertain,
  phase,
  stale,
}: Readonly<{
  uncertain: boolean;
  phase: (typeof ConnectionContinuationReview.Type)["phase"];
  stale: boolean;
}>): JSX.Element => (
  <>
    {uncertain && phase === "ready" ? (
      <p role="alert">
        No pudimos confirmar el resultado. Consulta el estado antes de continuar; no repitas esta
        solicitud.
      </p>
    ) : null}
    {stale ? (
      <p role="alert">
        No pudimos actualizar el estado. La información mostrada puede estar desactualizada.
      </p>
    ) : null}
  </>
);
type ReadyContinuation = Extract<ReturnType<typeof useContinuation>["result"], { _tag: "Ready" }>;
const ContinuationReview = ({
  task,
  review,
}: Readonly<{
  task: ReturnType<typeof useContinuation>;
  review: ReadyContinuation;
}>): JSX.Element => {
  const { busy, uncertain, submitted, begin, refresh, canFollow } = task;
  const { value, waiting, refreshFailure } = review;
  const { expired, check } = useExpiry(continuationDeadline(value));
  return (
    <>
      <ReviewNotices
        uncertain={uncertain}
        phase={value.phase}
        stale={Option.isSome(refreshFailure)}
      />
      <ExpiringReview
        review={value}
        busy={busy || waiting}
        expired={expired}
        blocked={Option.isSome(refreshFailure) || (submitted && value.phase === "ready")}
        begin={() => {
          if (check()) begin();
        }}
        canFollow={() => check() && canFollow(value)}
      />
      <Button
        variant="outline"
        disabled={expired || busy || waiting}
        onClick={() => {
          if (check()) refresh();
        }}
      >
        Consultar estado
      </Button>
    </>
  );
};
const Continuation = ({ attempt }: Readonly<{ attempt: AttemptReference }>): JSX.Element => {
  const task = useContinuation(attempt);
  const { result, mounted } = task;
  if (result._tag === "Initial") return <PendingRead label="Cargando solicitud" />;
  if (result._tag === "Failure") return <Unavailable attempt={attempt} />;
  return (
    <div ref={mounted} className="flex w-full max-w-md flex-col gap-3">
      <ContinuationReview
        key={continuationDeadline(result.value).epochMilliseconds}
        task={task}
        review={result}
      />
    </div>
  );
};

/** Navigation accepts only a public locator; the server verifies same-User authority. */
export const ConnectionContinuationFeature = (): JSX.Element => {
  const { sessionBinding } = useRouter().options.context;
  const { authentication } = useSession();
  const search = useSearch({ strict: false });
  const attempt = Schema.decodeUnknownOption(ConnectionAttemptReference)(search.attempt);
  if (Option.isNone(attempt)) {
    return (
      <ConnectionRecovery
        destination={
          authentication === "expired" || sessionBinding === "none" ? "/login" : "/app/transactions"
        }
      />
    );
  }
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 px-4 py-12">
      <Continuation key={`${sessionBinding}:${attempt.value}`} attempt={attempt.value} />
    </main>
  );
};

export const ConnectionResultFeature = (): JSX.Element => {
  const client = useRouter().options.context.apiClient;
  const [query] = useState(() =>
    client.query("connections", "listConnections", { timeToLive: "0 seconds" })
  );
  const result = useAtomValue(query).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(query);
  return (
    <main className="flex min-h-svh flex-col">
      <WorkspaceHeader title="Conexión con Bancolombia" context={null}>
        <Button variant="outline" disabled={result.waiting} onClick={refresh}>
          Consultar estado
        </Button>
      </WorkspaceHeader>
      <div className="flex max-w-2xl flex-col gap-5 p-5">
        {result._tag === "Initial" ? <PendingRead label="Consultando conexión" /> : null}
        {result._tag === "Failure" ? (
          <div role="alert">
            <p>
              No pudimos verificar la conexión. Inicia sesión con la cuenta de Fidy que comenzó la
              solicitud y vuelve a consultar.
            </p>
            <Button variant="outline" render={<Link to="/login" />}>
              Iniciar sesión
            </Button>
          </div>
        ) : null}
        {result._tag === "Ready" && Option.isSome(result.refreshFailure) ? (
          <p role="alert">
            No pudimos actualizar el estado. La información mostrada puede estar desactualizada.
          </p>
        ) : null}
        {result._tag === "Ready" ? <ConnectionResult connections={result.value.data} /> : null}
        <div>
          <Button variant="outline" render={<Link to="/app/transactions" />}>
            Volver a Fidy
          </Button>
        </div>
      </div>
    </main>
  );
};
