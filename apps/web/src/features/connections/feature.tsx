import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useRouter, useSearch } from "@tanstack/react-router";
import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { type JSX, useState } from "react";
import { ConnectionAttemptReference, type ConnectionContinuationReview } from "@/transport/client";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/components/card";

type AttemptReference = typeof ConnectionAttemptReference.Type;

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
      <Button render={<Link to="/auth/pair" search={{ connectionAttempt: attempt }} />}>
        Iniciar sesión
      </Button>
    </CardContent>
  </Card>
);
const ExpiringReview = ({
  review,
  busy,
  blocked,
  begin,
}: Readonly<{
  review: typeof ConnectionContinuationReview.Type;
  busy: boolean;
  blocked: boolean;
  begin: () => void;
}>): JSX.Element => {
  const client = useRouter().options.context.webAuthClient;
  const [expiry] = useState(() =>
    client.runtime.atom(
      Effect.gen(function* () {
        const current = yield* Clock.currentTimeMillis;
        yield* Effect.sleep(Math.max(0, review.expiresAt.epochMilliseconds - current));
        return true;
      })
    )
  );
  const expired = useAtomValue(expiry).pipe(presentCanonicalQuery)._tag === "Ready";
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
        <CardDescription>
          La autorización con Bancolombia todavía no está disponible. No se ha autorizado acceso a
          tus cuentas.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <p>No compartas claves bancarias, documentos de identidad ni números de cuenta en Fidy.</p>
        <p>
          Esta solicitud vence:{" "}
          <time dateTime={DateTime.formatIso(review.expiresAt)}>
            {new Intl.DateTimeFormat("es-CO", {
              dateStyle: "medium",
              timeStyle: "short",
              timeZone: "America/Bogota",
            }).format(DateTime.toDate(review.expiresAt))}
          </time>
          .
        </p>
        {expired ? <p role="alert">La solicitud venció. Inicia una nueva conexión.</p> : null}
        {review.phase === "ready" ? (
          <Button disabled={busy || blocked || expired} onClick={begin}>
            {busy ? "Continuando…" : "Continuar"}
          </Button>
        ) : null}
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
const Continuation = ({ attempt }: Readonly<{ attempt: AttemptReference }>): JSX.Element => {
  const client = useRouter().options.context.webAuthClient;
  const [query] = useState(() =>
    client.query("connectionBrowser", "review", { query: { attempt }, timeToLive: "0 seconds" })
  );
  const result = useAtomValue(query).pipe(presentCanonicalQuery);
  const refresh = useAtomRefresh(query);
  const [busy, setBusy] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const markUncertain = (): void => setUncertain(true);
  const settled = (): void => setBusy(false);
  const [command] = useState(() =>
    client.runtime.fn<void>()(
      () =>
        client.pipe(
          Effect.flatMap((api) => api.connectionBrowser.begin({ payload: { attempt } })),
          Effect.tap(() => Effect.sync(refresh)),
          Effect.asVoid,
          Effect.catchCause(() => Effect.sync(markUncertain)),
          Effect.ensuring(Effect.sync(settled))
        ),
      { concurrent: false }
    )
  );
  const run = useAtomSet(command);
  if (result._tag === "Initial") return <output>Cargando solicitud…</output>;
  if (result._tag === "Failure") return <Unavailable attempt={attempt} />;
  return (
    <div className="flex w-full max-w-md flex-col gap-3">
      <ReviewNotices
        uncertain={uncertain}
        phase={result.value.phase}
        stale={Option.isSome(result.refreshFailure)}
      />
      <ExpiringReview
        review={result.value}
        busy={busy || result.waiting}
        blocked={uncertain || Option.isSome(result.refreshFailure)}
        begin={() => {
          setBusy(true);
          run();
        }}
      />
      <Button variant="outline" disabled={busy || result.waiting} onClick={refresh}>
        Consultar estado
      </Button>
    </div>
  );
};

/** Only a public locator enters navigation; the server independently establishes same-User authority. */
export const ConnectionContinuationFeature = (): JSX.Element => {
  const search = useSearch({ strict: false });
  const attempt = Schema.decodeUnknownOption(ConnectionAttemptReference)(search.attempt);
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 px-4 py-12">
      {Option.isSome(attempt) ? (
        <Continuation key={attempt.value} attempt={attempt.value} />
      ) : (
        <p role="alert">La solicitud no es válida.</p>
      )}
    </main>
  );
};
