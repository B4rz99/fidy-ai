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
import { Alert, AlertDescription } from "@/ui/components/alert";
import { Button } from "@/ui/components/button";
import { OAuthClient } from "@/ui/components/oauth-review";
import { Checkbox } from "@/ui/components/checkbox";

import { formatExpiration } from "./expiration";

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
  <fieldset className="oauth-permissions">
    <legend>Permisos solicitados</legend>
    {input.permissions.map((permission) => (
      <label
        className="oauth-permission"
        htmlFor={`oauth-${permission.scope}`}
        key={permission.scope}
      >
        <Checkbox
          id={`oauth-${permission.scope}`}
          checked={input.scopes.has(permission.scope)}
          onCheckedChange={(checked) => input.toggle(permission.scope, checked)}
        />
        <span>
          <span className="oauth-permission-label">{permission.label}</span>
          <span className="oauth-permission-description">{permission.description}</span>
        </span>
      </label>
    ))}
  </fieldset>
);
const DurationChoices = (
  input: Readonly<{ days: PATLifetimeDays; select: (days: PATLifetimeDays) => void }>
): JSX.Element => (
  <fieldset className="oauth-duration">
    <legend>Duración</legend>
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
    <div className="oauth-actions">
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
const CancellationFailure = (): JSX.Element => (
  <div className="pt-6">
    <Alert variant="warning">
      <AlertDescription>
        No pudimos cancelar. Intenta de nuevo; no se autorizó ningún acceso.
      </AlertDescription>
    </Alert>
  </div>
);

export const OAuthReviewView = ({
  review,
  cancel,
  cancelling,
  connect,
  connecting,
  cancelFailed,
}: ReviewProps & Readonly<{ cancelFailed: boolean }>): JSX.Element => {
  const [scopes, setScopes] = useState<ReadonlyArray<PATScope>>(() => review.scopes);
  const [days, setDays] = useState<PATLifetimeDays>(defaultPATLifetimeDays);
  const expiration = DateTime.addDuration(review.reviewedAt, Duration.days(days));
  const toggle = (scope: PATScope, checked: boolean): void =>
    setScopes((current) =>
      checked ? [...current, scope] : current.filter((candidate) => candidate !== scope)
    );
  return (
    <div className="settings-columns">
      <div className="settings-main">
        {cancelFailed ? <CancellationFailure /> : null}
        <OAuthClient name={review.claimedClientName}>
          <PermissionChoices
            permissions={review.permissions}
            scopes={new Set(scopes)}
            toggle={toggle}
          />
          {scopes.length === 0 ? <p role="alert">Selecciona al menos un permiso.</p> : null}
        </OAuthClient>
      </div>
      <aside className="settings-panel oauth-panel" aria-label="Duración del acceso">
        <div className="oauth-panel-heading">
          <h2>Duración del acceso</h2>
          <p className="oauth-description">Elige cuándo vencerá esta conexión.</p>
        </div>
        <DurationChoices days={days} select={setDays} />
        <p className="oauth-expiration">
          <span className="oauth-description">Vencimiento previsto</span>
          <time dateTime={DateTime.formatIso(expiration)}>{formatExpiration(expiration)}</time>
        </p>
        <p className="oauth-request-expiration">
          Esta solicitud vence:{" "}
          <time dateTime={DateTime.formatIso(review.requestExpiresAt)}>
            {formatExpiration(review.requestExpiresAt)}
          </time>
        </p>
        <p className="oauth-renewal">
          El acceso vence en la fecha indicada. Para renovarlo tendrás que aprobar una nueva
          conexión.
        </p>
        <ReviewActions
          {...{ review, scopes, days, expiration, connect, connecting, cancelling, cancel }}
        />
      </aside>
    </div>
  );
};
