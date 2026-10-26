import {
  ArrowUpRight01Icon,
  CreditCardIcon,
  Mail01Icon,
  Shield01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { ErasureRequest } from "./erasure-request";
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
import { WorkspaceHeader } from "@/ui/components/workspace-layout";
import { RefreshButton } from "@/ui/components/refresh-button";
import { Badge } from "@/ui/components/badge";
import { formatPrivacyTime } from "./presentation";
import { AuthorizationCopy } from "./authorization-copy";
import { ConsentRenewal } from "./renewal";

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
  <div className="settings-section-actions">
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
        variant="destructive-outline"
        disabled={disabled || !confirmed}
        onClick={withdraw}
      >
        {waiting ? "Registrando retiro…" : "Retirar autorización"}
      </Button>
    </div>
  </div>
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
  client,
}: Readonly<{
  status: CanonicalQueryState<ProcessingConsentStatus, unknown>;
  children: JSX.Element;
  client: WebAuthClient;
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
    return (
      <>
        <ConsentReceipt value={status.value} />
        <ConsentRenewal client={client} withdrawalReference={status.value.withdrawal.reference} />
      </>
    );
  }
  if (status.value.status === "Missing") {
    return <p>No hay una autorización registrada para retirar.</p>;
  }
  return children;
};

const PrivacyExplanation = ({
  status,
}: Readonly<{ status: CanonicalQueryState<ProcessingConsentStatus, unknown> }>): JSX.Element => (
  <>
    <div className="settings-section-heading">
      <h2 className="settings-section-title">Autorización de tratamiento</h2>
      {status._tag === "Ready" &&
      Option.isNone(status.refreshFailure) &&
      status.value.status === "Granted" ? (
        <output aria-label="Tu autorización está vigente.">
          <Badge variant="success">Vigente</Badge>
        </output>
      ) : null}
    </div>
    <div className="settings-section-description">
      <p>
        Retirarla detiene nuevas solicitudes. Las que ya están en espera o en curso pueden terminar.
      </p>
      <p>No elimina tus datos, cancela tu suscripción ni revoca por separado un token.</p>
    </div>
  </>
);
const RightsContact = (): JSX.Element => (
  <section className="settings-section">
    <div className="settings-section-icon settings-contact-icon">
      <HugeiconsIcon icon={Mail01Icon} size={32} aria-hidden="true" />
    </div>
    <div className="settings-section-body flex flex-col gap-4">
      <h2 id="privacy-rights-contact-title" className="settings-section-title">
        Solicitudes sobre tus datos
      </h2>
      <p className="settings-section-description">
        Puedes escribirnos incluso sin iniciar sesión ni aceptar de nuevo el tratamiento.
      </p>
      <a className="underline" href="mailto:obarboza@fidyapp.com">
        obarboza@fidyapp.com
      </a>
      <a className="settings-policy-link underline" href="https://fidyapp.com/politica">
        Política de tratamiento de datos
        <HugeiconsIcon icon={ArrowUpRight01Icon} size={18} aria-hidden="true" />
      </a>
    </div>
  </section>
);

const AuthorizationSection = ({
  status,
  children,
}: Readonly<{
  status: CanonicalQueryState<ProcessingConsentStatus, unknown>;
  children: ReactNode;
}>): JSX.Element => (
  <section className="settings-section" aria-label="Autorización de tratamiento">
    <div className="settings-section-icon">
      <HugeiconsIcon icon={Shield01Icon} size={32} aria-hidden="true" />
    </div>
    <div className="settings-section-body">
      <PrivacyExplanation status={status} />
      {children}
    </div>
  </section>
);

const PrivacyWorkspace = ({
  busy,
  checkStatus,
  children,
}: Readonly<{ busy: boolean; checkStatus: () => void; children: ReactNode }>): JSX.Element => (
  <main className="settings-workspace">
    <WorkspaceHeader title="Privacidad" context={null}>
      <RefreshButton label="Verificar autorización" disabled={busy} onClick={checkStatus} />
    </WorkspaceHeader>
    <div className="settings-columns">
      <div className="settings-main">{children}</div>
      <aside className="settings-panel" aria-labelledby="privacy-rights-contact-title">
        <RightsContact />
      </aside>
    </div>
  </main>
);

const SavedTransactionsLink = (): JSX.Element => (
  <section className="settings-section">
    <div className="settings-section-icon">
      <HugeiconsIcon icon={CreditCardIcon} size={32} aria-hidden="true" />
    </div>
    <div className="settings-section-body">
      <h2 className="settings-section-title">Tus transacciones guardadas</h2>
      <div className="settings-section-description">
        <p>Puedes consultarlas gratis tras retirar la autorización, en modo de solo lectura.</p>
        <p>Requiere un inicio de sesión reciente. No reactiva el tratamiento.</p>
      </div>
      <div className="settings-section-actions">
        <div>
          <Button variant="outline" render={<Link to="/app/transactions" />}>
            Ver mis transacciones
          </Button>
        </div>
      </div>
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
      <AuthorizationSection status={status}>
        <ConsentContent status={status} client={client}>
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
            <Button variant="outline" render={<Link to="/login" reloadDocument />}>
              Iniciar sesión
            </Button>
          </div>
        ) : null}
      </AuthorizationSection>
      <AuthorizationCopy client={client} />
      <SavedTransactionsLink />
      <ErasureRequest client={client} />
    </PrivacyWorkspace>
  );
};
