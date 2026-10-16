import { Disclosure } from "@/ui/components/disclosure";
import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { Effect, Option } from "effect";
import { type Atom, Reactivity } from "effect/reactivity";
import { type JSX, useState } from "react";
import type { ProcessingAuthorization, WebAuthClient } from "@/transport/client";
import { presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import { Checkbox } from "@/ui/components/checkbox";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";

type RenewalInput = Readonly<{
  client: WebAuthClient;
  withdrawalReference: string;
  authorization: NonNullable<ProcessingAuthorization["authorization"]>;
}>;
const makeRenewal = ({
  client,
  withdrawalReference,
  authorization,
}: RenewalInput): Atom.AtomResultFn<void, boolean, never> =>
  client.runtime.fn<void>()(() =>
    client.pipe(
      Effect.flatMap((api) =>
        api.processingConsent.renew({
          payload: {
            confirm: true,
            withdrawalReference,
            authorizationReference: authorization.reference,
            disclosureSha256: authorization.disclosure.contentSha256,
          },
        })
      ),
      Effect.tap(() => Reactivity.invalidate(["processing-consent"])),
      Effect.as(true),
      Effect.catchCause(() => Effect.succeed(false))
    )
  );

const RenewalDisclosure = ({ authorization }: Pick<RenewalInput, "authorization">): JSX.Element => (
  <>
    <Disclosure title="Leer el aviso para renovar">
      <p className="mt-3 whitespace-pre-wrap">{authorization.disclosure.text}</p>
    </Disclosure>
    <p>
      Versión: {authorization.disclosure.revision}. Consulta la{" "}
      <a
        className="underline"
        href={authorization.disclosure.policy.publicUrl}
        target="_blank"
        rel="noreferrer"
      >
        política de tratamiento
      </a>
      .
    </p>
  </>
);

const RenewalChoice = ({
  client,
  withdrawalReference,
  authorization,
}: Readonly<{
  client: WebAuthClient;
  withdrawalReference: string;
  authorization: NonNullable<ProcessingAuthorization["authorization"]>;
}>): JSX.Element => {
  const [confirmed, setConfirmed] = useState(false);
  const [operation] = useState(() => makeRenewal({ client, withdrawalReference, authorization }));
  const result = useAtomValue(operation);
  const submit = useAtomSet(operation);
  return (
    <section aria-label="Renovar autorización" className="flex flex-col gap-4 border-t pt-6">
      <h2 className="text-xl font-semibold">Volver a autorizar</h2>
      <p>
        Al renovar, permites nuevas acciones de Fidy y el acceso de tus agentes con permisos
        vigentes. El retiro anterior se conserva. Los permisos revocados y las credenciales vencidas
        no se restauran.
      </p>
      <RenewalDisclosure authorization={authorization} />
      <label htmlFor="processing-renewal-confirmation" className="flex items-center gap-3">
        <Checkbox
          id="processing-renewal-confirmation"
          checked={confirmed}
          disabled={result.waiting}
          onCheckedChange={setConfirmed}
        />
        Leí el aviso y vuelvo a autorizar el tratamiento de mis datos.
      </label>
      <div>
        <Button type="button" disabled={!confirmed || result.waiting} onClick={() => submit()}>
          {result.waiting ? "Registrando autorización…" : "Renovar autorización"}
        </Button>
      </div>
      {result._tag === "Success" && !result.value ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>No pudimos confirmar la renovación</AlertTitle>
          <AlertDescription>
            Verifica el estado antes de reintentar. Necesitas un inicio de sesión reciente.
            <Link to="/auth/pair" className="underline">
              Iniciar sesión
            </Link>
          </AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
};

/** Explicit fresh-browser acceptance of the exact saved disclosure and current withdrawal. */
export const ConsentRenewal = ({
  client,
  withdrawalReference,
}: Readonly<{ client: WebAuthClient; withdrawalReference: string }>): JSX.Element => {
  const [query] = useState(() =>
    client.query("processingConsent", "authorization", {
      timeToLive: "0 seconds",
      reactivityKeys: ["processing-consent"],
    })
  );
  const queryResult = useAtomValue(query);
  const status = presentCanonicalQuery(queryResult);
  const refresh = useAtomRefresh(query);
  if (status._tag === "Initial") return <output>Consultando aviso para renovar…</output>;
  if (status._tag === "Failure" || Option.isSome(status.refreshFailure)) {
    return (
      <div>
        <p>No pudimos consultar el aviso.</p>
        <Button type="button" variant="outline" onClick={refresh}>
          Reintentar aviso
        </Button>
      </div>
    );
  }
  if (status.value.authorization === null) {
    return <p>No hay una autorización guardada para renovar.</p>;
  }
  return (
    <RenewalChoice
      key={withdrawalReference}
      client={client}
      withdrawalReference={withdrawalReference}
      authorization={status.value.authorization}
    />
  );
};
