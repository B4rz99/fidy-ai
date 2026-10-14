import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react";
import { Link, useRouter } from "@tanstack/react-router";
import { DateTime, Effect, Option } from "effect";
import { Atom, Reactivity } from "effect/reactivity";
import { type JSX, type ReactNode, useState } from "react";
import type { ProcessingConsentStatus, WebAuthClient } from "@/transport/client";
import { type CanonicalQueryState, presentCanonicalQuery } from "@/transport/canonical-query";
import { Button } from "@/ui/components/button";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Checkbox } from "@/ui/components/checkbox";
import { WorkspaceColumns, WorkspaceHeader } from "@/ui/components/workspace-layout";
import { formatPrivacyTime } from "./presentation";
import { AuthorizationCopy } from "./authorization-copy";

const consentKey = "processing-consent";

const makeWithdrawal = (client: WebAuthClient): Atom.AtomResultFn<void, boolean, never> =>
  client.runtime.fn<void>()(() =>
    client.pipe(
      Effect.flatMap((api) => api.processingConsent.withdraw({ payload: { confirm: true } })),
      Effect.flatMap((receipt) =>
        receipt.status === "Revoked"
          ? Reactivity.invalidate([consentKey]).pipe(Effect.as(true))
          : Effect.succeed(false)
      ),
      Effect.catchCause(() => Effect.succeed(false))
    )
  );

const WithdrawalChoice = ({
  disabled,
  waiting,
  confirmed,
  confirm,
  withdraw,
}: Readonly<{
  disabled: boolean;
  waiting: boolean;
  confirmed: boolean;
  confirm: (value: boolean) => void;
  withdraw: () => void;
}>): JSX.Element => (
  <section className="flex flex-col gap-4">
    <label htmlFor="processing-withdrawal-confirmation" className="flex items-center gap-3">
      <Checkbox
        id="processing-withdrawal-confirmation"
        checked={confirmed}
        disabled={disabled}
        onCheckedChange={confirm}
      />
      Entiendo las consecuencias y quiero retirar mi autorización de tratamiento.
    </label>
    <div>
      <Button
        type="button"
        variant="destructive"
        disabled={disabled || !confirmed}
        onClick={withdraw}
      >
        {waiting ? "Registrando retiro…" : "Retirar autorización"}
      </Button>
    </div>
  </section>
);

const ConsentReceipt = ({
  value,
}: Readonly<{ value: Extract<ProcessingConsentStatus, { status: "Revoked" }> }>): JSX.Element => (
  <section aria-label="Constancia de retiro" className="flex flex-col gap-2">
    <h2 className="text-xl font-semibold">Autorización retirada</h2>
    <p className="break-words">Referencia: {value.withdrawal.reference}</p>
    <p className="break-words">
      Registrado:{" "}
      <time dateTime={DateTime.formatIso(DateTime.makeUnsafe(value.withdrawal.occurredAtMs))}>
        {formatPrivacyTime(value.withdrawal.occurredAtMs)}
      </time>
    </p>
    <p>El retiro está registrado. La eliminación de datos requiere una solicitud separada.</p>
  </section>
);

const ConsentContent = ({
  status,
  children,
}: Readonly<{
  status: CanonicalQueryState<ProcessingConsentStatus, unknown>;
  children: JSX.Element;
}>): JSX.Element => {
  if (status._tag === "Initial") {
    return <output>Consultando autorización…</output>;
  }
  if (status._tag === "Failure" || Option.isSome(status.refreshFailure)) {
    return (
      <Alert variant="destructive" role="alert">
        <AlertTitle>No pudimos verificar tu autorización</AlertTitle>
        <AlertDescription>Inicia sesión o consulta el estado de nuevo.</AlertDescription>
      </Alert>
    );
  }
  if (status.value.status === "Revoked") {
    return <ConsentReceipt value={status.value} />;
  }
  if (status.value.status === "Missing") {
    return <p>No hay una autorización registrada para retirar.</p>;
  }
  return children;
};

const PrivacyExplanation = (): JSX.Element => (
  <>
    <h2 className="text-xl font-semibold">Retirar autorización</h2>
    <p>
      Retirar tu autorización detiene nuevas acciones que dependan de ella, incluido el acceso de
      tus agentes. La solicitud que ya esté en ejecución puede terminar después del retiro. Las
      solicitudes en espera no comenzarán.
    </p>
    <p>
      Esto no elimina tus datos, cancela la renovación de tu suscripción ni revoca por separado un
      token.
    </p>
  </>
);
const RightsContact = (): JSX.Element => (
  <section className="flex flex-col gap-4">
    <h2 className="text-xl font-semibold">Solicitudes sobre tus datos</h2>
    <p>
      Para consultar, corregir o solicitar la eliminación de tus datos, escribe a{" "}
      <a className="underline" href="mailto:obarboza@fidyapp.com">
        obarboza@fidyapp.com
      </a>
      . Puedes usar este canal sin iniciar sesión ni aceptar de nuevo el tratamiento.
    </p>
    <a className="underline" href="https://fidyapp.com/politica">
      Política de tratamiento de datos
    </a>
  </section>
);

const PrivacyWorkspace = ({
  busy,
  checkStatus,
  children,
}: Readonly<{ busy: boolean; checkStatus: () => void; children: ReactNode }>): JSX.Element => (
  <main className="flex min-h-svh min-w-0 flex-col xl:grid xl:grid-rows-[auto_1fr]">
    <WorkspaceHeader
      title="Privacidad y tratamiento de datos"
      context={
        <p className="mt-1 text-sm text-muted-foreground">
          Administra tu autorización y las solicitudes sobre tus datos.
        </p>
      }
    >
      <Button type="button" variant="outline" disabled={busy} onClick={checkStatus}>
        Verificar autorización
      </Button>
    </WorkspaceHeader>
    <WorkspaceColumns
      variant="default"
      panel={
        <aside className="min-w-0 border-t bg-card p-5 xl:border-t-0 xl:border-l">
          <RightsContact />
        </aside>
      }
    >
      <section className="flex max-w-2xl flex-col gap-6" aria-label="Autorización de tratamiento">
        <PrivacyExplanation />
        {children}
      </section>
    </WorkspaceColumns>
  </main>
);

const SavedTransactionsLink = (): JSX.Element => (
  <section className="flex flex-col gap-4 border-t pt-6">
    <h2 className="text-xl font-semibold">Tus transacciones guardadas</h2>
    <p>
      Puedes consultar tus transacciones después de retirar la autorización. Esta consulta es
      gratuita. Necesitas un inicio de sesión reciente. La vista será de solo lectura y no
      reactivará el tratamiento.
    </p>
    <div>
      <Button variant="outline" render={<Link to="/app/transactions" />}>
        Ver mis transacciones
      </Button>
    </div>
  </section>
);

/** Cookie-only privacy control; ordinary product access is not a prerequisite for withdrawal or its receipt. */
export const PrivacyFeature = (): JSX.Element => {
  const client = useRouter().options.context.webAuthClient;
  const [query] = useState(() =>
    client.query("processingConsent", "status", {
      reactivityKeys: [consentKey],
      timeToLive: "0 seconds",
    })
  );
  const statusResult = useAtomValue(query);
  const status = presentCanonicalQuery(statusResult);
  const refresh = useAtomRefresh(query);
  const [command] = useState(() => makeWithdrawal(client));
  const result = useAtomValue(command);
  const withdraw = useAtomSet(command);
  const [confirmed, setConfirmed] = useState(false);
  const attempted = result._tag !== "Initial";
  const busy = result.waiting || (status._tag === "Ready" && status.waiting);
  return (
    <PrivacyWorkspace
      busy={busy}
      checkStatus={() => {
        setConfirmed(false);
        withdraw(Atom.Reset);
        refresh();
      }}
    >
      <ConsentContent status={status}>
        <WithdrawalChoice
          disabled={busy || attempted}
          waiting={result.waiting}
          confirmed={confirmed}
          confirm={setConfirmed}
          withdraw={() => withdraw()}
        />
      </ConsentContent>
      {result._tag === "Success" && !result.value ? (
        <Alert variant="destructive" role="alert">
          <AlertTitle>No pudimos confirmar el resultado</AlertTitle>
          <AlertDescription>Consulta el estado antes de volver a intentarlo.</AlertDescription>
        </Alert>
      ) : null}
      {status._tag === "Failure" ? (
        <div>
          <Button variant="outline" render={<Link to="/auth/pair" />}>
            Iniciar sesión
          </Button>
        </div>
      ) : null}
      <AuthorizationCopy client={client} />
      <SavedTransactionsLink />
    </PrivacyWorkspace>
  );
};
