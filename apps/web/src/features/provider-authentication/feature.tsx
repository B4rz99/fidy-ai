import { ConsentDisclosureSkeleton } from "@/ui/components/settings-loading";
import { Option } from "effect";
import type { AuthenticationProvider } from "@/transport/client";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { type JSX, type ReactNode, useState } from "react";
import { Button } from "@/ui/components/button";
import {
  AccessAction,
  AccessBack,
  AccessConsent,
  AccessHeading,
  AccessMethodIcon,
} from "@/ui/components/access";
import { closeProviderReturn, useProviderAuthentication } from "./controller";

const canContinue = (intent: "signup" | "login", accepted: boolean, ready: boolean): boolean =>
  intent === "login" || (accepted && ready);
type Authentication = Omit<ReturnType<typeof useProviderAuthentication>, "mounted">;
const ConsentNotice = ({
  accepted,
  setAccepted,
}: Readonly<{ accepted: boolean; setAccepted: (value: boolean) => void }>): JSX.Element => {
  const router = useRouter();
  const query = router.options.context.webAuthClient.query(
    "providerAuthentication",
    "disclosure",
    {}
  );
  const disclosure = useAtomValue(query);
  const refresh = useAtomRefresh(query);
  return (
    <div data-access-consent="">
      {AsyncResult.match(disclosure, {
        onInitial: () => <ConsentDisclosureSkeleton />,
        onFailure: () => (
          <>
            <p role="alert">No pudimos cargar el Consentimiento.</p>
            <Button variant="outline" disabled={disclosure.waiting} onClick={refresh}>
              Volver a intentar
            </Button>
          </>
        ),
        onSuccess: ({ value }) => (
          <AccessConsent
            accepted={accepted}
            onAcceptedChange={setAccepted}
            policyUrl={value.policy.publicUrl}
          />
        ),
      })}
    </div>
  );
};
type EditingFormProps = Readonly<{
  children: ReactNode;
  intent: "signup" | "login";
  setIntent: (intent: "signup" | "login") => void;
  start: Authentication["start"];
  handoffReference: Option.Option<string>;
}>;
const EditingForm = ({
  intent,
  setIntent,
  start,
  handoffReference,
  children,
}: EditingFormProps): JSX.Element => {
  const router = useRouter();
  const disclosure = useAtomValue(
    router.options.context.webAuthClient.query("providerAuthentication", "disclosure", {})
  );
  const [accepted, setAccepted] = useState(false);
  return (
    <>
      {intent === "signup" && <ConsentNotice accepted={accepted} setAccepted={setAccepted} />}
      {(["google", "microsoft"] as const).map((provider) => (
        <AccessAction
          kind="provider"
          key={provider}
          disabled={!canContinue(intent, accepted, AsyncResult.isSuccess(disclosure))}
          onClick={() =>
            start(
              provider,
              intent,
              AsyncResult.isSuccess(disclosure) ? disclosure.value.revision : ""
            )
          }
        >
          <AccessMethodIcon method={provider} />
          Continuar con {provider === "google" ? "Google" : "Microsoft"}
        </AccessAction>
      ))}
      {intent === "login" ? children : null}
      {Option.isNone(handoffReference) && router.state.location.search.resume === undefined && (
        <p data-access-join="">
          {intent === "login" ? "¿Es tu primera vez? " : "¿Ya tienes cuenta? "}
          <AccessAction
            kind="link"
            onClick={() => {
              setIntent(intent === "signup" ? "login" : "signup");
              setAccepted(false);
            }}
          >
            {intent === "signup" ? "Iniciar sesión" : "Crea tu cuenta"}
          </AccessAction>
        </p>
      )}
    </>
  );
};
const ConfirmingStatus = ({
  authentication,
}: Readonly<{ authentication: Authentication }>): JSX.Element => (
  <>
    {authentication.state.status === "confirming" && (
      <>
        <output>
          Vuelve al chat de WhatsApp y escribe “Estado”. Revisa la cuenta y compara este
          identificador de asociación:
        </output>
        <p aria-label="Identificador de asociación" className="font-mono">
          {authentication.state.code}
        </p>
        <p>
          Confirma respondiendo al mensaje de revisión en tu chat. Si la cuenta no es la tuya,
          rechaza la asociación.
        </p>
        <Button variant="outline" onClick={authentication.cancel}>
          Cancelar
        </Button>
      </>
    )}
  </>
);
const RecoveryStatus = ({
  authentication,
}: Readonly<{ authentication: Authentication }>): JSX.Element => (
  <>
    {authentication.state.status === "recovery" && (
      <>
        <h2>Guarda tu código de recuperación</h2>
        <p>
          Se muestra una sola vez. Guárdalo fuera de Fidy; no lo compartas por WhatsApp ni soporte.
        </p>
        <p className="rounded border p-4 font-mono" aria-label="Código de recuperación">
          {authentication.state.code}
        </p>
        <Button onClick={authentication.acknowledge}>Lo guardé</Button>
      </>
    )}
  </>
);
const AssociationStatus = ({
  authentication,
}: Readonly<{ authentication: Authentication }>): JSX.Element => (
  <>
    {authentication.state.status === "associating" && (
      <>
        <p>
          Vincula {authentication.state.review.accountLabel} con tu WhatsApp
          {authentication.state.review.whatsappPhone === null
            ? ""
            : ` ${authentication.state.review.whatsappPhone}`}
          .
        </p>
        <p>Este chat podrá acceder a tu cuenta. En WhatsApp, solo pulsa Enviar para confirmar.</p>
        <Button onClick={authentication.approve}>Vincular y volver a WhatsApp</Button>
        <Button variant="outline" onClick={authentication.cancel}>
          Cancelar
        </Button>
      </>
    )}
  </>
);
const AttemptStatus = ({
  authentication,
  setIntent,
  provider,
}: Readonly<{
  provider: AuthenticationProvider;
  authentication: Authentication;
  setIntent: (intent: "signup" | "login") => void;
}>): JSX.Element => (
  <>
    <ConfirmingStatus authentication={authentication} />
    <AssociationStatus authentication={authentication} />
    {authentication.state.status === "awaiting_chat" && (
      <p>En WhatsApp, envía el mensaje preparado. Mantén esta página abierta para terminar.</p>
    )}
    <RecoveryStatus authentication={authentication} />
    {authentication.state.status === "waiting" && (
      <>
        <output>Esperando confirmación…</output>
        <Button variant="outline" onClick={authentication.cancel}>
          Cancelar
        </Button>
      </>
    )}
    <RetryStatus authentication={authentication} provider={provider} />
    {authentication.state.status === "uncertain" && (
      <>
        <p role="alert">
          No pudimos confirmar el acceso. La cuenta podría haberse creado. Inicia sesión con{" "}
          {provider === "google" ? "Google" : "Microsoft"} para comprobarlo. El código de
          recuperación perdido no se vuelve a mostrar.
        </p>
        <Button
          onClick={() => {
            setIntent("login");
            authentication.restart();
          }}
        >
          Ir a iniciar sesión
        </Button>
      </>
    )}
  </>
);
const RetryStatus = ({
  authentication,
  provider,
}: Readonly<{
  authentication: Authentication;
  provider: AuthenticationProvider;
}>): JSX.Element => (
  <>
    {(authentication.state.status === "refused" || authentication.state.status === "cancelled") && (
      <>
        <p role="alert">
          {authentication.state.status === "cancelled"
            ? "Cancelaste el acceso."
            : "No se completó el acceso. Puedes iniciar un nuevo intento."}
        </p>
        <p>
          Si sigue abierta, cierra la ventana de {provider === "google" ? "Google" : "Microsoft"}.
        </p>
        <Button onClick={authentication.retry}>Volver a intentar</Button>
      </>
    )}
  </>
);
const ProviderBack = ({
  authentication,
}: Readonly<{ authentication: Authentication }>): JSX.Element =>
  authentication.state.status === "editing" || authentication.state.status === "recovery" ? (
    <></>
  ) : (
    <AccessBack onClick={authentication.restart} />
  );

const ProviderIntroduction = ({
  intent,
  webSignup,
  status,
}: Readonly<{
  intent: "signup" | "login";
  webSignup: boolean;
  status: Authentication["state"]["status"];
}>): JSX.Element => {
  const router = useRouter();
  const confirmingIdentity = router.state.location.search.resume !== undefined;
  const confirmingToken = router.state.location.search.resume === "pat";
  return (
    <>
      <AccessHeading key={status}>
        {confirmingIdentity ? "Confirma tu identidad" : headingForIntent(intent)}
      </AccessHeading>
      <p data-access-intro="">
        {webSignup ? "Elige cómo crear tu cuenta." : "Elige cómo iniciar sesión."}
      </p>
      {confirmingToken && (
        <p>
          Usa la misma cuenta para volver a crear el token con el formulario que ya completaste.
        </p>
      )}
      {confirmingToken && (
        <a href="/settings/access?resume=pat" className="underline">
          Volver al token
        </a>
      )}
    </>
  );
};

const ProviderAuthenticationView = ({
  handoffReference,
  children,
  authentication,
}: Readonly<{
  handoffReference: Option.Option<string>;
  children: ReactNode;
  authentication: Authentication;
}>): JSX.Element => {
  const router = useRouter();
  const confirmingIdentity = router.state.location.search.resume !== undefined;
  const [intent, setIntent] = useState<"signup" | "login">(
    Option.isSome(handoffReference) && !confirmingIdentity ? "signup" : "login"
  );
  const webSignup = intent === "signup" && Option.isNone(handoffReference);
  return (
    <div data-access-principal="" data-access-signup={webSignup ? "" : undefined}>
      <ProviderBack authentication={authentication} />
      <ProviderIntroduction
        intent={intent}
        webSignup={webSignup}
        status={authentication.state.status}
      />
      {authentication.state.status === "editing" ? (
        <EditingForm
          handoffReference={handoffReference}
          intent={intent}
          setIntent={setIntent}
          start={authentication.start}
        >
          {children}
        </EditingForm>
      ) : (
        <AttemptStatus
          provider={authentication.provider}
          authentication={authentication}
          setIntent={setIntent}
        />
      )}
    </div>
  );
};

export type ProviderAuthenticationPresentation = Readonly<{
  restart: () => void;
  startLogin: (provider: AuthenticationProvider) => void;
  render: (children: ReactNode) => JSX.Element;
}>;

/** Keeps controller authority and lifetime behind this feature's public composition boundary. */
export const ProviderAuthenticationFeature = ({
  handoffReference,
  children,
}: Readonly<{
  handoffReference: Option.Option<string>;
  children: (presentation: ProviderAuthenticationPresentation) => ReactNode;
}>): JSX.Element => {
  const { mounted, ...authentication } = useProviderAuthentication({ handoffReference });
  return (
    <div ref={mounted}>
      {children({
        restart: authentication.restart,
        startLogin: (provider) => authentication.start(provider, "login", ""),
        render: (content) => (
          <ProviderAuthenticationView
            handoffReference={handoffReference}
            authentication={authentication}
          >
            {content}
          </ProviderAuthenticationView>
        ),
      })}
    </div>
  );
};

/** Clean provider return page; refreshing it cannot repeat provider completion or reveal recovery. */
export const ProviderReturnFeature = (): JSX.Element => (
  <main ref={closeProviderReturn}>
    <p>Puedes volver a la ventana de Fidy para continuar.</p>
    <a href="/login">Iniciar sesión</a>
  </main>
);

const headingForIntent = (intent: "signup" | "login"): string =>
  intent === "signup" ? "Crea tu cuenta" : "Entra a tu Fidy";
