import { DateTime, Duration } from "effect";
import { type JSX } from "react";
import {
  type OAuthReview,
  PATLifetimeDays,
  type PATScope,
  patLifetimeDayOptions,
} from "@/transport/client";
import { Button } from "@/ui/components/button";
import { OAuthClient } from "@/ui/components/oauth-review";
import { Checkbox } from "@/ui/components/checkbox";

import { formatExpiration } from "./expiration";

type ReviewProps = Readonly<{
  review: OAuthReview;
  cancel: () => void;
  cancelling: boolean;
  connecting: boolean;
  connect: () => void;
  scopes: ReadonlyArray<PATScope>;
  days: PATLifetimeDays;
  toggle: (scope: PATScope, checked: boolean) => void;
  select: (days: PATLifetimeDays) => void;
}>;
const PermissionChoices = (
  input: Readonly<{
    permissions: OAuthReview["permissions"];
    disabled: boolean;
    scopes: ReadonlySet<PATScope>;
    toggle: (scope: PATScope, checked: boolean) => void;
  }>
): JSX.Element => (
  <fieldset className="oauth-permissions" disabled={input.disabled}>
    <legend>Permisos solicitados</legend>
    {input.permissions.map((permission) => (
      <label
        className="oauth-permission"
        htmlFor={`oauth-${permission.scope}`}
        key={permission.scope}
      >
        <Checkbox
          id={`oauth-${permission.scope}`}
          disabled={input.disabled}
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
  input: Readonly<{
    days: PATLifetimeDays;
    select: (days: PATLifetimeDays) => void;
    disabled: boolean;
  }>
): JSX.Element => (
  <fieldset className="oauth-duration" disabled={input.disabled}>
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
  scopes,
  connect,
  connecting,
  cancelling,
  cancel,
}: Pick<
  ReviewProps,
  "scopes" | "connect" | "connecting" | "cancelling" | "cancel"
>): JSX.Element => (
  <div className="oauth-actions">
    <Button
      disabled={scopes.length === 0 || cancelling || connecting}
      type="button"
      onClick={connect}
    >
      {connecting ? "Conectando…" : "Conectar"}
    </Button>
    <Button disabled={cancelling || connecting} onClick={cancel} type="button" variant="outline">
      {cancelling ? "Cancelando…" : "Cancelar"}
    </Button>
  </div>
);

export const OAuthReviewView = ({
  review,
  cancel,
  cancelling,
  connect,
  connecting,
  scopes,
  days,
  toggle,
  select,
}: ReviewProps): JSX.Element => {
  const expiration = DateTime.addDuration(review.reviewedAt, Duration.days(days));
  return (
    <div className="settings-columns">
      <div className="settings-main">
        <OAuthClient name={review.claimedClientName}>
          <PermissionChoices
            disabled={connecting || cancelling}
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
        <DurationChoices days={days} select={select} disabled={connecting || cancelling} />
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
        <ReviewActions {...{ scopes, connect, connecting, cancelling, cancel }} />
      </aside>
    </div>
  );
};
