import { Key01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX } from "react";
import type { BackupRecoveryCode } from "@/transport/client";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Button } from "@/ui/components/button";

export type RotationState =
  | Readonly<{ _tag: "Idle" }>
  | Readonly<{ _tag: "Rotating" }>
  | Readonly<{ _tag: "Disclosed"; code: BackupRecoveryCode; copied: boolean }>
  | Readonly<{ _tag: "Failed" }>
  | Readonly<{ _tag: "FreshSessionRequired" }>;

const RotationFeedback = ({ state }: { state: RotationState }): JSX.Element => (
  <div className="flex flex-col gap-4">
    {state._tag === "Disclosed" ? (
      <Alert>
        <AlertTitle>Guárdalo ahora</AlertTitle>
        <AlertDescription className="flex flex-col gap-3">
          <span>
            Este código se muestra una sola vez. Guárdalo fuera de Fidy y no lo compartas.
          </span>
          <code className="break-all text-base font-semibold">{state.code}</code>
        </AlertDescription>
      </Alert>
    ) : null}
    {state._tag === "FreshSessionRequired" ? (
      <Alert>
        <AlertTitle>Inicia sesión de nuevo</AlertTitle>
        <AlertDescription>
          Por seguridad, necesitas una sesión reciente para crear un código nuevo. Tu sesión actual
          sigue activa.
        </AlertDescription>
      </Alert>
    ) : null}
    {state._tag === "Failed" ? (
      <Alert variant="destructive">
        <AlertTitle>No pudimos confirmar el código nuevo.</AlertTitle>
        <AlertDescription>
          Intenta crear otro código antes de cerrar esta página. Usa únicamente el último código que
          veas.
        </AlertDescription>
      </Alert>
    ) : null}
  </div>
);

const actionLabel = (state: RotationState): string => {
  if (state._tag === "Rotating") return "Creando código…";
  if (state._tag === "Failed") return "Intentar de nuevo";
  return "Crear un código nuevo";
};

const RotationAction = (props: {
  state: RotationState;
  onStart: () => void;
  onCopy: () => void;
}): JSX.Element => {
  if (props.state._tag === "FreshSessionRequired") {
    return (
      <div>
        <Button
          contentLayout="wrap"
          render={<a aria-label="Iniciar sesión" href="/login?resume=account" />}
        >
          Iniciar sesión
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-2">
      {props.state._tag === "Disclosed" ? (
        <Button contentLayout="wrap" onClick={props.onCopy} type="button">
          {props.state.copied ? "Copiado" : "Copiar código"}
        </Button>
      ) : (
        <Button
          contentLayout="wrap"
          disabled={props.state._tag === "Rotating"}
          onClick={props.onStart}
          type="button"
          variant="outline"
        >
          <HugeiconsIcon icon={Key01Icon} size={22} strokeWidth={1.5} aria-hidden="true" />
          {actionLabel(props.state)}
        </Button>
      )}
    </div>
  );
};

export const BackupRecoveryRotationPresentation = ({
  state,
  onStart,
  onCopy,
}: Readonly<{
  state: RotationState;
  onStart: () => void;
  onCopy: () => void;
}>): JSX.Element => (
  <section aria-label="Recuperación" className="settings-section">
    <div className="settings-section-icon" aria-hidden="true">
      <HugeiconsIcon icon={Key01Icon} size={30} strokeWidth={1.5} />
    </div>
    <div className="settings-section-body">
      <h2 className="settings-section-title">Código de recuperación</h2>
      <p className="settings-section-description">
        Al crear uno nuevo, el código anterior deja de funcionar de inmediato.
        <br />
        Se mostrará una sola vez. Guárdalo fuera de Fidy.
      </p>
      <div className="settings-section-actions">
        <RotationFeedback state={state} />
        <RotationAction onCopy={onCopy} onStart={onStart} state={state} />
      </div>
    </div>
  </section>
);
