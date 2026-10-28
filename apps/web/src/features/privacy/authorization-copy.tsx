import { File01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
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
    <section className="settings-section">
      <div className="settings-section-icon">
        <HugeiconsIcon icon={File01Icon} size={32} aria-hidden="true" />
      </div>
      <div className="settings-section-body">
        <h2 className="settings-section-title">Prueba de tu autorización</h2>
        <p className="settings-section-description">
          Consulta el aviso que aceptaste y la fecha de autorización. No vuelve a autorizar el
          tratamiento.
        </p>
        <div className="settings-section-actions">
          <div>
            <Button
              contentLayout="wrap"
              type="button"
              variant="outline"
              disabled={result.waiting}
              onClick={() => load()}
            >
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
        </div>
      </div>
    </section>
  );
};
