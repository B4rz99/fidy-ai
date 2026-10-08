import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { AsyncResult } from "effect/reactivity";
import { type JSX, useState } from "react";
import { Button } from "@/ui/components/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/components/card";
import { closeGoogleReturn, useGoogleAuthentication } from "./controller";

/** First-party web signup and returning login, with explicit signup Consent and one-time recovery. */
const canContinue = (intent: "signup" | "login", accepted: boolean, ready: boolean): boolean =>
  intent === "login" || (accepted && ready);
type Authentication = ReturnType<typeof useGoogleAuthentication>;
const EditingForm = ({
  intent,
  setIntent,
  start,
}: Readonly<{
  intent: "signup" | "login";
  setIntent: (intent: "signup" | "login") => void;
  start: Authentication["start"];
}>): JSX.Element => {
  const router = useRouter();
  const disclosure = useAtomValue(
    router.options.context.webAuthClient.query("providerAuthentication", "disclosure", {})
  );
  const [accepted, setAccepted] = useState(false);
  return (
    <>
      {intent === "signup" &&
        AsyncResult.match(disclosure, {
          onInitial: () => <p>Cargando información de Consentimiento…</p>,
          onFailure: () => (
            <p>No pudimos cargar el Consentimiento. Vuelve a intentarlo más tarde.</p>
          ),
          onSuccess: ({ value }) => (
            <>
              <p className="whitespace-pre-line text-sm">{value.text}</p>
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
      <Button
        disabled={!canContinue(intent, accepted, AsyncResult.isSuccess(disclosure))}
        onClick={() =>
          start(intent, AsyncResult.isSuccess(disclosure) ? disclosure.value.revision : "")
        }
      >
        Continuar con Google
      </Button>
      <Button
        variant="ghost"
        onClick={() => {
          setIntent(intent === "signup" ? "login" : "signup");
          setAccepted(false);
        }}
      >
        {intent === "signup" ? "Ya tengo cuenta · Iniciar sesión" : "Crear una cuenta"}
      </Button>
    </>
  );
};
const AttemptStatus = ({
  authentication,
  setIntent,
}: Readonly<{
  authentication: Authentication;
  setIntent: (intent: "signup" | "login") => void;
}>): JSX.Element => (
  <>
    {authentication.state.status === "waiting" && (
      <>
        <output>Esperando confirmación…</output>
        <Button variant="outline" onClick={authentication.cancel}>
          Cancelar
        </Button>
      </>
    )}
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
    {authentication.state.status === "uncertain" && (
      <>
        <p role="alert">
          No pudimos confirmar el acceso. La cuenta podría haberse creado. Inicia sesión con Google
          para comprobarlo. El código de recuperación perdido no se vuelve a mostrar.
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
export const GoogleAuthenticationFeature = (): JSX.Element => {
  const [intent, setIntent] = useState<"signup" | "login">("signup");
  const { mounted, ...authentication } = useGoogleAuthentication();
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
            <EditingForm intent={intent} setIntent={setIntent} start={authentication.start} />
          ) : (
            <AttemptStatus authentication={{ ...authentication, mounted }} setIntent={setIntent} />
          )}
        </CardContent>
      </Card>
    </main>
  );
};

/** Clean provider return page; refreshing it cannot repeat provider completion or reveal recovery. */
export const GoogleReturnFeature = (): JSX.Element => (
  <main ref={closeGoogleReturn}>
    <p>Puedes volver a la ventana de Fidy para continuar.</p>
    <a href="/auth/google">Iniciar sesión</a>
  </main>
);
