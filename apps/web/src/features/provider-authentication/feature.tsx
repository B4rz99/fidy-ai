import { Option, Schema } from "effect";
import { type AuthenticationProvider, PATPairingPublicCode } from "@/transport/client";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { type JSX, useState } from "react";
import { Button } from "@/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/components/card";
import { closeProviderReturn, useProviderAuthentication } from "./controller";

/** First-party web signup and returning login, with explicit signup Consent and one-time recovery. */
const canContinue = (intent: "signup" | "login", accepted: boolean, ready: boolean): boolean =>
  intent === "login" || (accepted && ready);
type Authentication = ReturnType<typeof useProviderAuthentication>;
const ProviderChoice = ({
  provider,
  handoffReference,
}: Readonly<{
  provider: AuthenticationProvider;
  handoffReference: Option.Option<string>;
}>): JSX.Element => {
  const router = useRouter();
  const cliCode = Schema.decodeUnknownOption(PATPairingPublicCode)(
    router.state.location.search.cliCode
  );
  const search = new URLSearchParams();
  if (Option.isSome(handoffReference)) search.set("handoff", handoffReference.value);
  if (Option.isSome(cliCode)) search.set("cliCode", cliCode.value);
  return (
    <a
      className="text-center underline"
      href={`${provider === "google" ? "/auth/microsoft" : "/auth/google"}?${search.toString()}`}
    >
      {provider === "google" ? "Microsoft" : "Google"}
    </a>
  );
};
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
    <>
      {AsyncResult.match(disclosure, {
        onInitial: () => <p>Cargando información de Consentimiento…</p>,
        onFailure: () => (
          <>
            <p role="alert">No pudimos cargar el Consentimiento.</p>
            <Button variant="outline" disabled={disclosure.waiting} onClick={refresh}>
              Volver a intentar
            </Button>
          </>
        ),
        onSuccess: ({ value }) => (
          <>
            <p className="text-sm">
              {value.text}
              <br />
              <a
                className="underline"
                href={value.policy.publicUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                Política de privacidad
              </a>
            </p>
            <label className="flex gap-2">
              <input
                type="checkbox"
                checked={accepted}
                onChange={(event) => setAccepted(event.target.checked)}
              />
              Acepto el tratamiento de datos descrito
            </label>
          </>
        ),
      })}
    </>
  );
};
const EditingForm = ({
  intent,
  setIntent,
  start,
  provider,
  handoffReference,
}: Readonly<{
  intent: "signup" | "login";
  setIntent: (intent: "signup" | "login") => void;
  start: Authentication["start"];
  provider: AuthenticationProvider;
  handoffReference: Option.Option<string>;
}>): JSX.Element => {
  const router = useRouter();
  const disclosure = useAtomValue(
    router.options.context.webAuthClient.query("providerAuthentication", "disclosure", {})
  );
  const [accepted, setAccepted] = useState(false);
  return (
    <>
      {intent === "signup" && Option.isNone(handoffReference) && (
        <ConsentNotice accepted={accepted} setAccepted={setAccepted} />
      )}
      <Button
        disabled={
          Option.isNone(handoffReference) &&
          !canContinue(intent, accepted, AsyncResult.isSuccess(disclosure))
        }
        onClick={() =>
          start(intent, AsyncResult.isSuccess(disclosure) ? disclosure.value.revision : "")
        }
      >
        Continuar con {provider === "google" ? "Google" : "Microsoft"}
      </Button>
      <ProviderChoice provider={provider} handoffReference={handoffReference} />
      {Option.isNone(handoffReference) && (
        <Button
          variant="ghost"
          onClick={() => {
            setIntent(intent === "signup" ? "login" : "signup");
            setAccepted(false);
          }}
        >
          {intent === "signup" ? "Ya tengo cuenta · Iniciar sesión" : "Crear una cuenta"}
        </Button>
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
    <RecoveryStatus authentication={authentication} />
    {authentication.state.status === "waiting" && (
      <>
        <output>Esperando confirmación…</output>
        <Button variant="outline" onClick={authentication.cancel}>
          Cancelar
        </Button>
      </>
    )}
    {(authentication.state.status === "refused" || authentication.state.status === "cancelled") && (
      <>
        <p role="alert">
          {authentication.state.status === "cancelled"
            ? "Cancelaste el acceso."
            : "No se completó el acceso. Puedes iniciar un nuevo intento."}
        </p>
        <Button onClick={authentication.retry}>Volver a intentar</Button>
      </>
    )}
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
export const ProviderAuthenticationFeature = ({
  provider,
  handoffReference,
}: Readonly<{
  provider: AuthenticationProvider;
  handoffReference: Option.Option<string>;
}>): JSX.Element => {
  const [intent, setIntent] = useState<"signup" | "login">("signup");
  const { mounted, ...authentication } = useProviderAuthentication({ provider, handoffReference });
  return (
    <main ref={mounted} className="flex min-h-svh items-center justify-center px-4 py-12">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>
            <h1>{intent === "signup" ? "Crea tu cuenta" : "Inicia sesión"}</h1>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {authentication.state.status === "editing" ? (
            <EditingForm
              provider={provider}
              handoffReference={handoffReference}
              intent={intent}
              setIntent={setIntent}
              start={authentication.start}
            />
          ) : (
            <AttemptStatus
              provider={provider}
              authentication={{ ...authentication, mounted }}
              setIntent={setIntent}
            />
          )}
        </CardContent>
      </Card>
    </main>
  );
};

/** Clean provider return page; refreshing it cannot repeat provider completion or reveal recovery. */
export const ProviderReturnFeature = ({
  provider,
}: Readonly<{ provider: AuthenticationProvider }>): JSX.Element => (
  <main ref={closeProviderReturn}>
    <p>Puedes volver a la ventana de Fidy para continuar.</p>
    <a href={`/auth/${provider}`}>Iniciar sesión</a>
  </main>
);
