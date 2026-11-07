import { type JSX, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "./alert";
import { Button } from "./button";

type Props = Readonly<{
  fields: ReadonlyArray<Readonly<{ label: string; value: string }>>;
  checked: boolean;
  waiting: boolean;
  onCheck: () => void;
  onResume: () => void;
  onDiscard: () => void;
  onHistory: () => void;
}>;

export const TransactionCaptureRecovery = ({
  fields,
  checked,
  waiting,
  onCheck,
  onResume,
  onDiscard,
  onHistory,
}: Props): JSX.Element => {
  const [discarding, setDiscarding] = useState(false);
  return (
    <section className="flex min-w-0 flex-col gap-5" aria-label="Borrador por revisar">
      <Alert variant="warning">
        <AlertTitle>Guardado sin confirmar</AlertTitle>
        <AlertDescription>
          No pudimos confirmar si la transacción se guardó. Conservamos los datos del intento; este
          borrador no confirma una transacción guardada.
        </AlertDescription>
      </Alert>
      <section aria-label="Datos del intento">
        <dl className="flex min-w-0 flex-col gap-4">
          {fields.map((field) => (
            <div key={field.label} className="min-w-0">
              <dt className="text-sm text-muted-foreground">{field.label}</dt>
              <dd className="whitespace-pre-wrap break-words tabular-nums">{field.value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <p className="text-sm text-muted-foreground">
        {checked
          ? "Compara estos datos con el historial. No encontrar una coincidencia no confirma que el intento haya fallado."
          : "Actualiza el historial antes de preparar un nuevo registro. Si la actualización falla, el borrador se conserva y el nuevo registro sigue bloqueado."}
      </p>
      <div className="flex flex-col gap-3">
        <Button variant="outline" disabled={waiting} onClick={onCheck}>
          Actualizar historial
        </Button>
        <Button variant="outline" contentLayout="wrap" onClick={onHistory}>
          Ver historial · conservar borrador
        </Button>
        <Button disabled={!checked || waiting} onClick={onResume} contentLayout="wrap">
          No la encontré · editar borrador
        </Button>
        <Button variant="destructive" onClick={() => setDiscarding(true)}>
          Descartar borrador…
        </Button>
      </div>
      {discarding ? (
        <DiscardCapture onDiscard={onDiscard} onCancel={() => setDiscarding(false)} />
      ) : null}
    </section>
  );
};

const DiscardCapture = ({
  onDiscard,
  onCancel,
}: Readonly<{ onDiscard: () => void; onCancel: () => void }>): JSX.Element => (
  <section aria-label="Confirmar descarte del borrador" className="flex flex-col gap-3">
    <p>
      ¿Descartar este borrador? Se quitarán los datos conservados de este intento. Esto no elimina
      ninguna transacción del historial ni confirma el resultado original.
    </p>
    <Button variant="destructive" onClick={onDiscard}>
      Descartar borrador
    </Button>
    <Button variant="outline" onClick={onCancel}>
      Conservar borrador
    </Button>
  </section>
);
