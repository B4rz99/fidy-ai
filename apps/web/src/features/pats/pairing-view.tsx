import { DateTime, Option, Schema } from "effect";
import { type FormEvent, type JSX, useState } from "react";
import type { PATPairingId, PATPairingReview } from "@/transport/client";
import { PATPairingPublicCode, patScopeCopy } from "@/transport/client";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/components/card";
import { Label } from "@/ui/components/label";
import { Input } from "@/ui/components/input";

export type InspectPATPairingCommand = Readonly<{
  publicCode: string;
  onInspected: (review: PATPairingReview) => void;
  onFailed: () => void;
}>;
export type ApprovePATPairingCommand = Readonly<{
  pairingId: PATPairingId;
  onApproved: () => void;
  onFailed: () => void;
}>;

type PairingState =
  | Readonly<{ _tag: "Entering"; publicCode: string }>
  | Readonly<{ _tag: "Inspecting"; publicCode: string }>
  | Readonly<{ _tag: "Reviewing"; review: PATPairingReview; publicCode: Option.Option<string> }>
  | Readonly<{ _tag: "Approving"; review: PATPairingReview; publicCode: Option.Option<string> }>
  | Readonly<{ _tag: "Invalid"; publicCode: Option.Option<string> }>
  | Readonly<{ _tag: "Approved" }>;

const initialState: PairingState = { _tag: "Entering", publicCode: "" };
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
              href={`/auth/pair?cliCode=${encodeURIComponent(publicCode.value)}`}
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
  failed,
  approved,
}: Readonly<{
  state: Extract<PairingState, { _tag: "Reviewing" | "Approving" }>;
  approve: (command: ApprovePATPairingCommand) => void;
  reset: () => void;
  failed: () => void;
  approved: () => void;
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
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button disabled={busy} onClick={reset} type="button" variant="outline">
            Cancelar
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              approve({
                pairingId: state.review.pairingId,
                onApproved: approved,
                onFailed: failed,
              })
            }
            type="button"
          >
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
}: Readonly<{
  state: Extract<PairingState, { _tag: "Entering" | "Inspecting" }>;
  inspect: (publicCode: string) => void;
  update: (publicCode: string) => void;
}>): JSX.Element => {
  const busy = state._tag === "Inspecting";
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!busy && state.publicCode.trim().length > 0) inspect(state.publicCode);
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
        </form>
      </div>
    </section>
  );
};

/** Fresh-session review surface; it never receives a private proof or PAT bearer. */
export const PATPairingView = ({
  inspect,
  approve,
  initialReview,
  publicCode,
}: Readonly<{
  initialReview: Option.Option<PATPairingReview>;
  publicCode: Option.Option<string>;
  inspect: (command: InspectPATPairingCommand) => void;
  approve: (command: ApprovePATPairingCommand) => void;
}>): JSX.Element => {
  const [state, setState] = useState<PairingState>(() =>
    Option.isSome(initialReview)
      ? { _tag: "Reviewing", review: initialReview.value, publicCode }
      : initialState
  );
  const reset = (): void => setState(initialState);
  if (state._tag === "Invalid") {
    return <InvalidPairingCard reset={reset} publicCode={state.publicCode} />;
  }
  if (state._tag === "Approved") return <ApprovedPairingCard />;
  if (state._tag === "Reviewing" || state._tag === "Approving") {
    return (
      <PairingReviewCard
        approve={(command) => {
          setState({ ...state, _tag: "Approving" });
          approve(command);
        }}
        approved={() => setState({ _tag: "Approved" })}
        failed={() => setState({ _tag: "Invalid", publicCode: Option.none() })}
        reset={reset}
        state={state}
      />
    );
  }
  return (
    <PairingCodeSection
      inspect={(value) => {
        const publicCode = value.trim().toUpperCase();
        setState({ _tag: "Inspecting", publicCode });
        inspect({
          publicCode,
          onInspected: (review) =>
            setState({ _tag: "Reviewing", review, publicCode: Option.some(publicCode) }),
          onFailed: () =>
            setState({
              _tag: "Invalid",
              publicCode: Schema.decodeOption(PATPairingPublicCode)(publicCode),
            }),
        });
      }}
      state={state}
      update={(publicCode) => setState({ _tag: "Entering", publicCode })}
    />
  );
};
