import { Option } from "effect";
import type { AuthenticationProvider } from "@/transport/client";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { type JSX, type ReactNode, useState } from "react";
import { Button } from "@/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/components/card";
import { closeProviderReturn, useProviderAuthentication } from "./controller";

const canContinue = (intent: "signup" | "login", accepted: boolean, ready: boolean): boolean =>
  intent === "login" || (accepted && ready);
type Authentication = ReturnType<typeof useProviderAuthentication>;
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
  handoffReference,
}: Readonly<{
  intent: "signup" | "login";
  setIntent: (intent: "signup" | "login") => void;
  start: Authentication["start"];
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
      {(["google", "microsoft"] as const).map((provider) => (
        <Button
          key={provider}
          disabled={
            Option.isNone(handoffReference) &&
            !canContinue(intent, accepted, AsyncResult.isSuccess(disclosure))
          }
          onClick={() =>
            start(
              provider,
              intent,
              AsyncResult.isSuccess(disclosure) ? disclosure.value.revision : ""
            )
          }
        >
          Continuar con {provider === "google" ? "Google" : "Microsoft"}
        </Button>
      ))}
      {Option.isNone(handoffReference) && router.state.location.search.resume === undefined && (
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
  handoffReference,
  children,
}: Readonly<{
  handoffReference: Option.Option<string>;
  children: ReactNode;
}>): JSX.Element => {
  const router = useRouter();
  const confirmingIdentity = router.state.location.search.resume !== undefined;
  const confirmingToken = router.state.location.search.resume === "pat";
  const [intent, setIntent] = useState<"signup" | "login">(confirmingIdentity ? "login" : "signup");
  const { mounted, ...authentication } = useProviderAuthentication({ handoffReference });
  return (
    <main ref={mounted} className="flex min-h-svh items-center justify-center px-4 py-12">
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>
            <h1>{confirmingIdentity ? "Confirma tu identidad" : headingForIntent(intent)}</h1>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
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
          {authentication.state.status === "editing" ? (
            <EditingForm
              handoffReference={handoffReference}
              intent={intent}
              setIntent={setIntent}
              start={authentication.start}
            />
          ) : (
            <AttemptStatus
              provider={authentication.provider}
              authentication={{ ...authentication, mounted }}
              setIntent={setIntent}
            />
          )}
          {authentication.state.status === "editing" ? children : null}
        </CardContent>
      </Card>
    </main>
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
  intent === "signup" ? "Crea tu cuenta" : "Inicia sesión";
