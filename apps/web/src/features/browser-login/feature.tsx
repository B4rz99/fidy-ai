import { KeyRoundIcon, MessageCircleIcon } from "lucide-react";
import type { JSX } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Button } from "@/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/components/card";
import { Spinner } from "@/ui/components/spinner";
import {
  type BrowserLoginPairingViewState,
  invalidPairingMessage,
  useBrowserLoginPairing,
} from "./pairing-controller";
import { browserLoginPairingWhatsAppUrl } from "./whatsapp-link";

type PairingStatusProps = Readonly<{
  state: BrowserLoginPairingViewState;
  onStart: () => void;
  onRestart: () => void;
  onLogout: () => void;
}>;

const AwaitingPairing = ({ publicCode }: Readonly<{ publicCode: string }>): JSX.Element => (
  <div className="space-y-4">
    <Alert>
      <MessageCircleIcon aria-hidden="true" />
      <AlertTitle>Aprueba en WhatsApp</AlertTitle>
      <AlertDescription>
        Confirma que el código que muestra Fidy coincide con este código.
      </AlertDescription>
    </Alert>
    <p
      aria-label={`Código de vinculación ${publicCode}`}
      className="rounded-lg border bg-background py-4 text-center font-mono text-3xl font-semibold tracking-[0.2em]"
    >
      {publicCode}
    </p>
    <Button
      className="w-full"
      render={
        <a
          aria-label="Abrir WhatsApp"
          href={browserLoginPairingWhatsAppUrl(publicCode)}
          rel="noreferrer"
        />
      }
    >
      Abrir WhatsApp
    </Button>
    <p
      aria-live="polite"
      className="flex items-center justify-center gap-2 text-sm text-muted-foreground"
    >
      <Spinner /> Esperando aprobación…
    </p>
  </div>
);

const AuthenticatedSession = ({ onLogout }: Readonly<{ onLogout: () => void }>): JSX.Element => (
  <div className="space-y-4">
    <Alert>
      <AlertTitle>Sesión iniciada</AlertTitle>
      <AlertDescription>Este navegador ahora tiene una sesión de Fidy guardada.</AlertDescription>
    </Alert>
    <Button className="w-full" onClick={onLogout} type="button" variant="outline">
      Cerrar sesión
    </Button>
  </div>
);

const PairingStatus = ({
  state,
  onLogout,
  onRestart,
  onStart,
}: PairingStatusProps): JSX.Element => {
  switch (state._tag) {
    case "Idle":
      return (
        <Button className="w-full" onClick={onStart} type="button">
          Iniciar sesión en el navegador
        </Button>
      );
    case "Starting":
      return (
        <Button className="w-full" disabled type="button">
          <Spinner /> Iniciando vinculación segura…
        </Button>
      );
    case "AwaitingApproval":
      return <AwaitingPairing publicCode={state.publicCode} />;
    case "Authenticated":
      return <AuthenticatedSession onLogout={onLogout} />;
    case "Invalid":
      return (
        <Alert variant="destructive">
          <AlertTitle>La vinculación terminó</AlertTitle>
          <AlertDescription className="space-y-3">
            <p>{invalidPairingMessage}</p>
            <Button onClick={onRestart} size="sm" type="button" variant="outline">
              Iniciar de nuevo
            </Button>
          </AlertDescription>
        </Alert>
      );
  }
};

/** Browser-first pairing surface. Nothing is created until its primary button is pressed. */
export const BrowserLoginPairingFeature = (): JSX.Element => {
  const pairing = useBrowserLoginPairing();

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <KeyRoundIcon aria-hidden="true" className="size-5" />
          </div>
          <CardTitle>
            <h1 className="text-2xl">Inicia sesión en Fidy</h1>
          </CardTitle>
          <CardDescription>
            Empieza aquí y luego aprueba este navegador desde tu conversación con Fidy en WhatsApp.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <PairingStatus
            onLogout={pairing.logout}
            onRestart={pairing.restart}
            onStart={pairing.start}
            state={pairing.state}
          />
        </CardContent>
      </Card>
    </main>
  );
};
