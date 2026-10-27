import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useRouter, useSearch } from "@tanstack/react-router";
import { Clock, DateTime, Effect, Option, Schema } from "effect";
import { type JSX, useState } from "react";
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
}: Readonly<{
  review: typeof ConnectionContinuationReview.Type;
  disabled: boolean;
}>): JSX.Element => {
  if (disabled || review.authorization === undefined) return <></>;
  return (
    <a className={buttonVariants()} href={review.authorization.url} rel="noreferrer">
      Continuar en Bancolombia
    </a>
  );
};
const continuationDeadline = (review: typeof ConnectionContinuationReview.Type): DateTime.Utc =>
  review.authorization?.expiresAt ?? review.expiresAt;
const preparationBlocked = (
  review: typeof ConnectionContinuationReview.Type,
  uncertain: boolean,
  stale: boolean
): boolean => stale || (uncertain && review.phase === "ready");
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
  const expiresAt = continuationDeadline(review);
  const [expiry] = useState(() =>
    client.runtime.atom(
      Effect.gen(function* () {
        const current = yield* Clock.currentTimeMillis;
        yield* Effect.sleep(Math.max(0, expiresAt.epochMilliseconds - current));
        return true;
      })
    )
  );
  const expired = useAtomValue(expiry).pipe(presentCanonicalQuery)._tag === "Ready";
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
        <BankHandoff review={review} disabled={disabled} />
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
        key={continuationDeadline(result.value).epochMilliseconds}
        review={result.value}
        busy={busy || result.waiting}
        blocked={preparationBlocked(result.value, uncertain, Option.isSome(result.refreshFailure))}
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

/** Navigation accepts only a public locator; the server verifies same-User authority. */
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
