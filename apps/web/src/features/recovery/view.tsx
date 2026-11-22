import { Key01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Predicate } from "effect";
import type { JSX, ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Button } from "@/ui/components/button";
import { RotationState } from "./view-state";

const signInRequired = Predicate.or(
  Predicate.or(RotationState.$is("FreshSessionRequired"), RotationState.$is("Unauthenticated")),
  RotationState.$is("Uncertain")
);

const RotationFeedback = ({ state }: { state: RotationState }): JSX.Element => (
  <div className="flex flex-col gap-4">
    {RotationState.$is("Reviewing")(state) ? (
      <Alert>
        <AlertTitle>Revisa antes de continuar</AlertTitle>
        <AlertDescription>
          Confirmar invalida el código anterior de inmediato. El código nuevo se mostrará una sola
          vez. Guárdalo fuera de Fidy antes de salir de esta página.
        </AlertDescription>
      </Alert>
    ) : null}
    {RotationState.$is("FreshSessionRequired")(state) ? (
      <Alert>
        <AlertTitle>Inicia sesión de nuevo</AlertTitle>
        <AlertDescription>
          Por seguridad, necesitas una sesión reciente para crear un código nuevo. Tu sesión actual
          sigue activa.
        </AlertDescription>
      </Alert>
    ) : null}
    {RotationState.$is("Unauthenticated")(state) ? (
      <Alert>
        <AlertTitle>Inicia sesión para continuar</AlertTitle>
        <AlertDescription>Necesitas una sesión válida para crear un código nuevo.</AlertDescription>
      </Alert>
    ) : null}
    {RotationState.$is("Uncertain")(state) ? (
      <Alert variant="warning">
        <AlertTitle>No pudimos confirmar el código nuevo.</AlertTitle>
        <AlertDescription>
          El cambio puede haberse completado y el código anterior puede haber dejado de funcionar.
          No podemos volver a mostrar un código cuya respuesta se perdió. Inicia sesión de nuevo
          antes de revisar la creación de otro código.
        </AlertDescription>
      </Alert>
    ) : null}
  </div>
);

const actionLabel = (state: RotationState): string => {
  if (RotationState.$is("Rotating")(state)) {
    return "Creando código…";
  }

  return "Crear un código nuevo";
};

const RotationAction = (props: {
  state: RotationState;
  onStart: () => void;
  onCopy: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element => {
  if (RotationState.$is("Disposed")(props.state)) {
    return <></>;
  }

  if (RotationState.$is("Reviewing")(props.state)) {
    return (
      <div className="flex flex-wrap gap-2">
        <Button contentLayout="wrap" onClick={props.onConfirm} type="button">
          Confirmar código nuevo
        </Button>
        <Button contentLayout="wrap" onClick={props.onCancel} type="button" variant="outline">
          Cancelar
        </Button>
      </div>
    );
  }

  if (signInRequired(props.state)) {
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
      {RotationState.$is("Disclosed")(props.state) ? (
        <Button contentLayout="wrap" onClick={props.onCopy} type="button">
          {props.state.copied ? "Copiado" : "Copiar código"}
        </Button>
      ) : (
        <Button
          contentLayout="wrap"
          disabled={RotationState.$is("Rotating")(props.state)}
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
  onConfirm,
  onCancel,
  disclosure,
}: Readonly<{
  state: RotationState;
  onStart: () => void;
  onCopy: () => void;
  onConfirm: () => void;
  onCancel: () => void;
  disclosure: ReactNode;
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
        {disclosure}
        <RotationAction
          onCopy={onCopy}
          onStart={onStart}
          onConfirm={onConfirm}
          onCancel={onCancel}
          state={state}
        />
      </div>
    </div>
  </section>
);
