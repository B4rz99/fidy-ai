import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { Effect } from "effect";
import { type JSX, useState } from "react";
import type { WebAuthClient } from "@/transport/client";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Button } from "@/ui/components/button";
import { Checkbox } from "@/ui/components/checkbox";

export const ErasureRequest = ({ client }: Readonly<{ client: WebAuthClient }>): JSX.Element => {
  const [confirmed, confirm] = useState(false);
  const [command] = useState(() =>
    client.runtime.fn<void>()(() =>
      client.pipe(
        Effect.flatMap((api) => api.processingConsent.erase({ payload: { confirm: true } })),
        Effect.as(true),
        Effect.catchCause(() => Effect.succeed(false))
      )
    )
  );
  const result = useAtomValue(command);
  const submit = useAtomSet(command);
  const accepted = result._tag === "Success" && result.value;
  return (
    <section className="flex flex-col gap-4 border-t pt-6" aria-label="Solicitud de eliminación">
      <h2 className="text-xl font-semibold">Eliminar tus datos</h2>
      <p>
        Elimina los datos de tu cuenta. Necesitas un inicio de sesión reciente. Al confirmar,
        bloquearemos nuevas operaciones y comenzaremos la eliminación. Las copias de respaldo y los
        datos en proveedores pueden tardar más en eliminarse.
      </p>
      <label htmlFor="erasure-confirmation" className="flex items-center gap-3">
        <Checkbox
          id="erasure-confirmation"
          checked={confirmed}
          disabled={result.waiting || accepted}
          onCheckedChange={confirm}
        />
        Quiero solicitar la eliminación de los datos de mi cuenta.
      </label>
      <div>
        <Button
          type="button"
          variant="destructive"
          disabled={!confirmed || result.waiting || accepted}
          onClick={() => submit()}
        >
          {result.waiting ? "Registrando solicitud…" : "Solicitar eliminación"}
        </Button>
      </div>
      <ErasureFeedback accepted={accepted} failed={result._tag === "Success" && !result.value} />
    </section>
  );
};

const ErasureFeedback = ({
  accepted,
  failed,
}: Readonly<{ accepted: boolean; failed: boolean }>): JSX.Element => (
  <>
    {accepted ? (
      <Alert>
        <AlertTitle>Solicitud de eliminación aceptada</AlertTitle>
        <AlertDescription>
          La eliminación está en curso y aún no ha finalizado. Puedes escribir a
          obarboza@fidyapp.com para consultar el estado de tu solicitud, incluso cuando ya no puedas
          entrar a tu cuenta.
        </AlertDescription>
      </Alert>
    ) : null}
    {failed ? (
      <Alert variant="destructive" role="alert">
        <AlertTitle>No pudimos confirmar la solicitud</AlertTitle>
        <AlertDescription>
          Inicia sesión de nuevo e inténtalo otra vez, o escribe al contacto de esta página.
          Reintentar esta confirmación no crea otra solicitud.
        </AlertDescription>
      </Alert>
    ) : null}
  </>
);
