import { Disclosure } from "@/ui/components/disclosure";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { DateTime, Effect, Option } from "effect";
import { type JSX, useState } from "react";
import type { ProcessingAuthorization, WebAuthClient } from "@/transport/client";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { formatPrivacyTime } from "./presentation";
import { Button } from "@/ui/components/button";

const AuthorizationRecord = ({
  value,
}: Readonly<{ value: ProcessingAuthorization }>): JSX.Element => {
  if (value.authorization === null) {
    return <p>No hay una autorización de tratamiento registrada.</p>;
  }
  const record = value.authorization;
  return (
    <section aria-label="Copia de autorización" className="flex flex-col gap-3">
      <p className="break-words">Referencia: {record.reference}</p>
      <p>
        Otorgada:{" "}
        <time dateTime={DateTime.formatIso(DateTime.makeUnsafe(record.acceptedAtMs))}>
          {formatPrivacyTime(record.acceptedAtMs)}
        </time>
      </p>
      <p>Versión del aviso: {record.disclosure.revision}</p>
      <Disclosure title="Ver el aviso que autorizaste">
        <p className="mt-3 whitespace-pre-wrap">{record.disclosure.text}</p>
      </Disclosure>
    </section>
  );
};

/** Explicit same-browser access to saved Consent evidence, including after processing withdrawal. */
export const AuthorizationCopy = ({ client }: Readonly<{ client: WebAuthClient }>): JSX.Element => {
  const [operation] = useState(() =>
    client.runtime.fn<void>()(() =>
      client.pipe(
        Effect.flatMap((api) => api.processingConsent.authorization()),
        Effect.asSome,
        Effect.catchCause(() => Effect.succeedNone)
      )
    )
  );
  const result = useAtomValue(operation);
  const load = useAtomSet(operation);
  return (
    <section className="flex flex-col gap-4 border-t pt-6">
      <h2 className="text-xl font-semibold">Prueba de tu autorización</h2>
      <p>
        Consulta una copia del aviso que aceptaste y la fecha en que autorizaste el tratamiento.
        Esta consulta no vuelve a otorgar autorización.
      </p>
      <div>
        <Button type="button" variant="outline" disabled={result.waiting} onClick={() => load()}>
          {result.waiting ? "Consultando prueba…" : "Consultar prueba"}
        </Button>
      </div>
      {result._tag === "Success" && Option.isSome(result.value) ? (
        <AuthorizationRecord value={result.value.value} />
      ) : null}
      {result._tag === "Success" && Option.isNone(result.value) ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>No pudimos consultar la prueba</AlertTitle>
          <AlertDescription>
            Verifica tu sesión e intenta de nuevo. No se cambió tu autorización.
          </AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
};
