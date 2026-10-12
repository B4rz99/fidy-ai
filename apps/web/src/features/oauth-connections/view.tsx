import { DateTime, Duration, Option, Schema } from "effect";
import { type JSX, useState } from "react";
import {
  type OAuthReview,
  OAuthReviewChoice,
  PATLifetimeDays,
  type PATScope,
  defaultPATLifetimeDays,
  patLifetimeDayOptions,
} from "@/transport/client";
import { Button } from "@/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/components/card";
import { Input } from "@/ui/components/input";

const formatter = new Intl.DateTimeFormat("es-CO", {
  dateStyle: "long",
  timeStyle: "short",
  timeZone: "America/Bogota",
});
const formatExpiration = (value: DateTime.Utc): string => formatter.format(DateTime.toDate(value));
type ReviewProps = Readonly<{
  review: OAuthReview;
  cancel: () => void;
  cancelling: boolean;
  connecting: boolean;
  connect: (choice: OAuthReviewChoice) => void;
}>;
const PermissionChoices = (
  input: Readonly<{
    permissions: OAuthReview["permissions"];
    scopes: ReadonlySet<PATScope>;
    toggle: (scope: PATScope, checked: boolean) => void;
  }>
): JSX.Element => (
  <fieldset className="flex flex-col gap-3">
    <legend className="mb-2 font-medium">Permisos solicitados</legend>
    {input.permissions.map((permission) => (
      <label
        className="flex items-start gap-2"
        htmlFor={`oauth-${permission.scope}`}
        key={permission.scope}
      >
        <Input
          className="mt-1 size-4"
          id={`oauth-${permission.scope}`}
          type="checkbox"
          checked={input.scopes.has(permission.scope)}
          onChange={(event) => input.toggle(permission.scope, event.currentTarget.checked)}
        />
        <span>
          <span className="block font-medium">{permission.label}</span>
          <span className="text-sm text-muted-foreground">{permission.description}</span>
        </span>
      </label>
    ))}
  </fieldset>
);
const DurationChoices = (
  input: Readonly<{ days: PATLifetimeDays; select: (days: PATLifetimeDays) => void }>
): JSX.Element => (
  <fieldset className="flex flex-wrap gap-2">
    <legend className="mb-2 font-medium">Duración</legend>
    {patLifetimeDayOptions.map((option) => (
      <Button
        aria-pressed={input.days === option}
        key={option}
        type="button"
        variant={input.days === option ? "default" : "outline"}
        onClick={() => input.select(PATLifetimeDays.make(option))}
      >
        {option} días
      </Button>
    ))}
  </fieldset>
);
const ReviewActions = ({
  review,
  scopes,
  days,
  expiration,
  connect,
  connecting,
  cancelling,
  cancel,
}: ReviewProps &
  Readonly<{
    scopes: ReadonlyArray<PATScope>;
    days: PATLifetimeDays;
    expiration: DateTime.Utc;
  }>): JSX.Element => {
  const submit = (): void => {
    const choice = Schema.decodeOption(Schema.toType(OAuthReviewChoice))({
      requestId: review.requestId,
      scopes,
      lifetimeDays: days,
      reviewedAt: review.reviewedAt,
      expiresAt: expiration,
    });
    if (Option.isSome(choice)) connect(choice.value);
  };
  return (
    <div className="flex gap-2">
      <Button
        disabled={scopes.length === 0 || cancelling || connecting}
        type="button"
        onClick={submit}
      >
        {connecting ? "Conectando…" : "Conectar"}
      </Button>
      <Button disabled={cancelling || connecting} onClick={cancel} type="button" variant="outline">
        {cancelling ? "Cancelando…" : "Cancelar"}
      </Button>
    </div>
  );
};
/** Render only reviewed permissions as text; local choices can narrow but cannot grant authority. */
export const OAuthReviewView = ({
  review,
  cancel,
  cancelling,
  connect,
  connecting,
}: ReviewProps): JSX.Element => {
  const [scopes, setScopes] = useState<ReadonlyArray<PATScope>>(() => review.scopes);
  const [days, setDays] = useState<PATLifetimeDays>(defaultPATLifetimeDays);
  const expiration = DateTime.addDuration(review.reviewedAt, Duration.days(days));
  const toggle = (scope: PATScope, checked: boolean): void =>
    setScopes((current) =>
      checked ? [...current, scope] : current.filter((candidate) => candidate !== scope)
    );
  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>
          <h1>Conectar con Fidy</h1>
        </CardTitle>
        <CardDescription>
          Nombre declarado por el cliente; Fidy no verifica su identidad.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <p className="break-words font-semibold">{review.claimedClientName}</p>
        <PermissionChoices
          permissions={review.permissions}
          scopes={new Set(scopes)}
          toggle={toggle}
        />
        {scopes.length === 0 ? <p role="alert">Selecciona al menos un permiso.</p> : null}
        <DurationChoices days={days} select={setDays} />
        <p className="text-sm">
          Vencimiento previsto:{" "}
          <time dateTime={DateTime.formatIso(expiration)}>{formatExpiration(expiration)}</time>
        </p>
        <p className="text-sm text-muted-foreground">
          Esta solicitud vence:{" "}
          <time dateTime={DateTime.formatIso(review.requestExpiresAt)}>
            {formatExpiration(review.requestExpiresAt)}
          </time>
          .
        </p>
        <p className="text-sm text-muted-foreground">
          El acceso vence en la fecha indicada. Para renovarlo tendrás que aprobar una nueva
          conexión.
        </p>
        <ReviewActions
          {...{ review, scopes, days, expiration, connect, connecting, cancelling, cancel }}
        />
      </CardContent>
    </Card>
  );
};
