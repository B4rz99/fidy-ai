import { type JSX, useState } from "react";
import { Button } from "./components/button";
import { Checkbox } from "./components/checkbox";
import { OAuthClient, OAuthNotice, OAuthStatus } from "./components/oauth-review";

const exampleDurations = ["7", "30", "90", "365"];
const PermissionExample = (): JSX.Element => {
  const [selected, select] = useState(true);
  return (
    <OAuthClient name="Agente de ejemplo">
      <fieldset className="oauth-permissions">
        <legend>Permisos de ejemplo</legend>
        <label className="oauth-permission" htmlFor="oauth-reference-scope">
          <Checkbox id="oauth-reference-scope" checked={selected} onCheckedChange={select} />
          <span>
            <span className="oauth-permission-label">Consultar tus datos</span>
            <span className="oauth-permission-description">
              Permiso local de ejemplo, sin acceso a datos.
            </span>
          </span>
        </label>
      </fieldset>
    </OAuthClient>
  );
};
const DurationExample = (): JSX.Element => {
  const [duration, select] = useState("90");
  return (
    <fieldset className="oauth-duration">
      <legend>Duración de ejemplo</legend>
      {exampleDurations.map((days) => (
        <Button
          key={days}
          type="button"
          aria-pressed={duration === days}
          variant={duration === days ? "default" : "outline"}
          onClick={() => select(days)}
        >
          {days} días
        </Button>
      ))}
    </fieldset>
  );
};
const ReviewExample = ({
  decide,
}: Readonly<{ decide: (kind: "success" | "information" | "warning") => void }>): JSX.Element => (
  <div className="settings-columns">
    <div className="settings-main">
      <PermissionExample />
    </div>
    <aside className="settings-panel oauth-panel" aria-label="Acciones de ejemplo">
      <div className="oauth-panel-heading">
        <h2>Duración del acceso</h2>
        <p className="oauth-description">Selecciona una duración de ejemplo.</p>
      </div>
      <DurationExample />
      <OAuthNotice kind="information">
        Este ejemplo no autoriza ni ejecuta una operación.
      </OAuthNotice>
      <div className="oauth-actions">
        <Button onClick={() => decide("success")}>Simular aprobación</Button>
        <Button variant="outline" onClick={() => decide("information")}>
          Simular cancelación
        </Button>
        <Button variant="outline" onClick={() => decide("warning")}>
          Simular resultado incierto
        </Button>
      </div>
    </aside>
  </div>
);
const outcomes = {
  success: {
    title: "Aprobación registrada",
    description: "Ejemplo: vuelve a tu agente para continuar. No se ejecutó ninguna operación.",
  },
  information: {
    title: "Operación cancelada",
    description: "Ejemplo: no se ejecutó ningún cambio.",
  },
  warning: {
    title: "Resultado por confirmar",
    description:
      "Ejemplo: consulta el estado antes de continuar; no repitas una aprobación incierta.",
  },
};

/** Local controls exercise shared OAuth treatments without creating credentials or account reads. */
export const OAuthReference = (): JSX.Element => {
  const [state, select] = useState<"review" | "success" | "information" | "warning">("review");
  return (
    <section id="oauth" aria-label="Autorizaciones de ejemplo">
      <h2 className="mb-4 text-2xl font-semibold">Autorizaciones</h2>
      <p className="mb-4 text-sm text-muted-foreground">
        Referencia local: prueba Tab, Espacio y Enter en permisos y duración. No modifica accesos ni
        datos.
      </p>
      <div className="application-shell settings-workspace oauth-workspace">
        {state === "review" ? (
          <ReviewExample decide={select} />
        ) : (
          <OAuthStatus kind={state} title={outcomes[state].title}>
            <p>{outcomes[state].description}</p>
            <Button variant="outline" onClick={() => select("review")}>
              Reiniciar ejemplo
            </Button>
          </OAuthStatus>
        )}
      </div>
    </section>
  );
};
