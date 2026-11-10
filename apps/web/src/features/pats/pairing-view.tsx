import { DateTime, Option } from "effect";
import { type FormEvent, type JSX } from "react";
import type { PATPairingReview } from "@/transport/client";
import { patScopeCopy } from "@/transport/client";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/components/card";
import { Label } from "@/ui/components/label";
import { Input } from "@/ui/components/input";

import type { PATPairingActions, PATPairingDisplay } from "./pairing";

const formatter = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "America/Bogota",
});
const format = (value: DateTime.Utc): JSX.Element => (
  <time dateTime={DateTime.formatIso(value)}>{formatter.format(DateTime.toDate(value))}</time>
);

const PairingReviewDetails = ({ review }: Readonly<{ review: PATPairingReview }>): JSX.Element => (
  <dl className="grid gap-2 sm:grid-cols-[10rem_1fr]">
    <dt className="text-muted-foreground">Nombre indicado</dt>
    <dd className="font-medium">{review.recipientLabel}</dd>
    <dt className="text-muted-foreground">Permisos solicitados</dt>
    <dd className="flex flex-wrap gap-2">
      {review.scopes.map((scope) => (
        <Badge key={scope} variant="secondary">
          {patScopeCopy[scope].label}
        </Badge>
      ))}
    </dd>
    <dt className="text-muted-foreground">Vigencia desde la autorización</dt>
    <dd className="font-medium">{review.lifetimeDays} días</dd>
    <dt className="text-muted-foreground">Completar la conexión antes de</dt>
    <dd className="font-medium">{format(review.claimBy)}</dd>
  </dl>
);

const InvalidPairingCard = ({
  reset,
  publicCode,
}: Readonly<{ reset: () => void; publicCode: Option.Option<string> }>): JSX.Element => (
  <Card>
    <CardContent className="flex flex-col gap-4">
      <Alert variant="destructive">
        <AlertTitle>No encontramos ese código</AlertTitle>
        <AlertDescription>El código no es válido o ya no está disponible.</AlertDescription>
      </Alert>
      {Option.isSome(publicCode) ? (
        <Button
          nativeButton={false}
          render={
            <a
              aria-label="Iniciar sesión para revisar la solicitud"
              href={`/login?cliCode=${encodeURIComponent(publicCode.value)}`}
            />
          }
        >
          Iniciar sesión para revisar la solicitud
        </Button>
      ) : null}
      <Button onClick={reset} type="button" variant="outline">
        Ingresar otro código
      </Button>
    </CardContent>
  </Card>
);

const ApprovedPairingCard = (): JSX.Element => (
  <Card>
    <CardContent>
      <Alert>
        <AlertTitle>Acceso autorizado</AlertTitle>
        <AlertDescription>
          Puedes cerrar esta pestaña y volver a la terminal para completar la conexión. Este
          navegador no recibe ni muestra la clave de acceso.
        </AlertDescription>
      </Alert>
    </CardContent>
  </Card>
);

const PairingReviewCard = ({
  state,
  approve,
  reset,
}: Readonly<{
  state: Extract<PATPairingDisplay, { _tag: "Reviewing" | "Approving" }>;
  approve: () => void;
  reset: () => void;
}>): JSX.Element => {
  const busy = state._tag === "Approving";
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Confirma el acceso</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {Option.isSome(state.publicCode) ? (
          <p className="text-sm">
            Confirma que este código coincide con tu terminal:{" "}
            <strong className="font-mono">{state.publicCode.value}</strong>.
          </p>
        ) : null}
        <p className="text-sm text-muted-foreground">
          El nombre lo indica el solicitante; no verifica su identidad. Continúa solo si tú
          iniciaste esta conexión.
        </p>
        <PairingReviewDetails review={state.review} />
        {busy ? (
          <output className="text-sm text-muted-foreground">
            La autorización enviada puede completarse aunque cierres esta revisión.
          </output>
        ) : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button onClick={reset} type="button" variant="outline">
            {busy ? "Cerrar revisión" : "Cancelar"}
          </Button>
          <Button disabled={busy} onClick={approve} type="button">
            {busy ? "Autorizando…" : "Autorizar acceso"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

const PairingCodeSection = ({
  state,
  inspect,
  update,
  reset,
}: Readonly<{
  state: Extract<PATPairingDisplay, { _tag: "Entering" | "Inspecting" }>;
  reset: () => void;
  inspect: () => void;
  update: (publicCode: string) => void;
}>): JSX.Element => {
  const busy = state._tag === "Inspecting";
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!busy && state.publicCode.trim().length > 0) inspect();
  };
  return (
    <section className="flex min-w-0 flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-xl font-semibold">Autorizar acceso con código</h2>

        <p className="text-sm text-muted-foreground">
          Ingresa el código que aparece donde quieres usar Fidy.
        </p>
      </div>
      <div>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <div className="flex flex-col gap-2">
            <Label htmlFor="pat-pairing-code">Código</Label>
            <Input
              autoComplete="off"
              disabled={busy}
              id="pat-pairing-code"
              onChange={(event) => update(event.target.value)}
              placeholder="BCDF-GHJK"
              value={state.publicCode}
            />
          </div>
          <Button
            className="self-start"
            disabled={busy || state.publicCode.trim().length === 0}
            type="submit"
            variant="outline"
          >
            {busy ? "Buscando…" : "Continuar"}
          </Button>
          {busy ? (
            <Button onClick={reset} type="button" variant="outline">
              Cancelar
            </Button>
          ) : null}
        </form>
      </div>
    </section>
  );
};

export const PATPairingView = ({
  state,
  actions,
}: Readonly<{ state: PATPairingDisplay; actions: PATPairingActions }>): JSX.Element => {
  if (state._tag === "Invalid") {
    return <InvalidPairingCard reset={actions.reset} publicCode={state.publicCode} />;
  }
  if (state._tag === "ApprovalUnknown") {
    return (
      <Card>
        <CardContent>
          <Alert variant="warning">
            <AlertTitle>No pudimos confirmar la autorización</AlertTitle>
            <AlertDescription>
              La solicitud puede haberse autorizado. Revisa tus tokens en Accesos y desactiva el
              acceso si no quieres conservarlo. Volver a esta página no repite la autorización.
            </AlertDescription>
          </Alert>
          <Button
            nativeButton={false}
            render={<a href="/settings/access" aria-label="Revisar accesos" />}
          >
            Revisar accesos
          </Button>
        </CardContent>
      </Card>
    );
  }
  if (state._tag === "Approved") return <ApprovedPairingCard />;
  if (state._tag === "Reviewing" || state._tag === "Approving") {
    return <PairingReviewCard approve={actions.approve} reset={actions.reset} state={state} />;
  }
  return (
    <PairingCodeSection
      state={state}
      inspect={actions.inspect}
      update={actions.update}
      reset={actions.reset}
    />
  );
};
