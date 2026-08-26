import { DateTime } from "effect";
import { type FormEvent, type JSX, useState } from "react";
import type { PATPairingId, PATPairingReview } from "@/transport/client";
import { patScopeCopy } from "@/transport/client";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/components/card";
import { Input } from "@/ui/components/input";

export type InspectPATPairingCommand = Readonly<{
  publicCode: string;
  onInspected: (review: PATPairingReview) => void;
  onFailed: () => void;
}>;
export type ApprovePATPairingCommand = Readonly<{
  pairingId: PATPairingId;
  patExpiresAt: DateTime.Utc;
  onApproved: () => void;
  onFailed: () => void;
}>;

type PairingState =
  | Readonly<{ _tag: "Entering"; publicCode: string }>
  | Readonly<{ _tag: "Inspecting"; publicCode: string }>
  | Readonly<{ _tag: "Reviewing"; review: PATPairingReview }>
  | Readonly<{ _tag: "Approving"; review: PATPairingReview }>
  | Readonly<{ _tag: "Invalid" }>
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
    <dt className="text-muted-foreground">Duración</dt>
    <dd className="font-medium">{review.lifetimeDays} días</dd>
    <dt className="text-muted-foreground">Acceso válido hasta</dt>
    <dd className="font-medium">{format(review.patExpiresAt)}</dd>
    <dt className="text-muted-foreground">Completar la conexión antes de</dt>
    <dd className="font-medium">{format(review.claimBy)}</dd>
  </dl>
);

const InvalidPairingCard = ({ reset }: Readonly<{ reset: () => void }>): JSX.Element => (
  <Card>
    <CardContent className="flex flex-col gap-4">
      <Alert variant="destructive">
        <AlertTitle>No encontramos ese código</AlertTitle>
        <AlertDescription>El código no es válido o ya no está disponible.</AlertDescription>
      </Alert>
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
          Vuelve al lugar donde obtuviste el código para completar la conexión. Este navegador no
          recibe ni muestra la clave de acceso.
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
                patExpiresAt: state.review.patExpiresAt,
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

const PairingCodeCard = ({
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
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Autorizar acceso con código</h2>
        </CardTitle>
        <CardDescription>Ingresa el código que aparece donde quieres usar Fidy.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-4" onSubmit={submit}>
          <div className="flex flex-col gap-2">
            <label className="font-medium" htmlFor="pat-pairing-code">
              Código
            </label>
            <Input
              autoComplete="off"
              disabled={busy}
              id="pat-pairing-code"
              onChange={(event) => update(event.target.value)}
              placeholder="BCDF-GHJK"
              value={state.publicCode}
            />
          </div>
          <Button disabled={busy || state.publicCode.trim().length === 0} type="submit">
            {busy ? "Buscando…" : "Continuar"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
};

/** Fresh-session review surface; it never receives a private proof or PAT bearer. */
export const PATPairingView = ({
  inspect,
  approve,
}: Readonly<{
  inspect: (command: InspectPATPairingCommand) => void;
  approve: (command: ApprovePATPairingCommand) => void;
}>): JSX.Element => {
  const [state, setState] = useState<PairingState>(initialState);
  const reset = (): void => setState(initialState);
  if (state._tag === "Invalid") return <InvalidPairingCard reset={reset} />;
  if (state._tag === "Approved") return <ApprovedPairingCard />;
  if (state._tag === "Reviewing" || state._tag === "Approving") {
    return (
      <PairingReviewCard
        approve={(command) => {
          setState({ _tag: "Approving", review: state.review });
          approve(command);
        }}
        approved={() => setState({ _tag: "Approved" })}
        failed={() => setState({ _tag: "Invalid" })}
        reset={reset}
        state={state}
      />
    );
  }
  return (
    <PairingCodeCard
      inspect={(value) => {
        const publicCode = value.trim().toUpperCase();
        setState({ _tag: "Inspecting", publicCode });
        inspect({
          publicCode,
          onInspected: (review) => setState({ _tag: "Reviewing", review }),
          onFailed: () => setState({ _tag: "Invalid" }),
        });
      }}
      state={state}
      update={(publicCode) => setState({ _tag: "Entering", publicCode })}
    />
  );
};
