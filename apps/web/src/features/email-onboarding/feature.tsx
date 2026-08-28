import { KeyRoundIcon, ShieldCheckIcon } from "lucide-react";
import { type FormEvent, type JSX, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Button } from "@/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/components/card";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import { Spinner } from "@/ui/components/spinner";
import { type EmailOnboardingViewState, useEmailOnboarding } from "./controller";

type VerificationFormProps = Readonly<{
  invalid: boolean;
  restart: () => void;
  verify: (combinedCode: string) => void;
}>;

const VerificationForm = ({ invalid, restart, verify }: VerificationFormProps): JSX.Element => {
  const [combinedCode, setCombinedCode] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    verify(combinedCode);
    setCombinedCode("");
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      {invalid && (
        <div className="flex flex-col gap-3">
          <Alert variant="destructive">
            <AlertTitle>El código no es válido</AlertTitle>
            <AlertDescription>Revisa el correo o solicita uno nuevo por WhatsApp.</AlertDescription>
          </Alert>
          <Button className="w-full" onClick={restart} type="button" variant="outline">
            Empezar de nuevo
          </Button>
        </div>
      )}
      <div className="flex flex-col gap-2">
        <Label htmlFor="combined-code">Código de verificación</Label>
        <Input
          autoCapitalize="characters"
          autoComplete="one-time-code"
          autoCorrect="off"
          id="combined-code"
          inputMode="text"
          maxLength={29}
          onChange={(event) => setCombinedCode(event.target.value.toUpperCase())}
          placeholder="ABCD-2345-F7KM-9Q2D-X4PT-6RWC"
          spellCheck={false}
          value={combinedCode}
        />
      </div>
      <Button className="w-full" disabled={combinedCode.length === 0} type="submit">
        Verificar y crear mi cuenta
      </Button>
    </form>
  );
};

const OnboardingState = ({
  acknowledge,
  restart,
  state,
  verify,
}: Readonly<{
  acknowledge: () => void;
  restart: () => void;
  state: EmailOnboardingViewState;
  verify: (combinedCode: string) => void;
}>): JSX.Element => {
  if (state._tag === "Editing" || state._tag === "Invalid") {
    return (
      <VerificationForm invalid={state._tag === "Invalid"} restart={restart} verify={verify} />
    );
  }
  if (state._tag === "Submitting") {
    return (
      <Button className="w-full" disabled type="button">
        <Spinner /> Verificando…
      </Button>
    );
  }
  if (state._tag === "Recovery") {
    return (
      <div className="flex flex-col gap-4">
        <Alert>
          <ShieldCheckIcon aria-hidden="true" />
          <AlertTitle>Guarda tu código de recuperación</AlertTitle>
          <AlertDescription>
            Se muestra una sola vez. Guárdalo fuera de Fidy; no lo compartas por WhatsApp ni
            soporte.
          </AlertDescription>
        </Alert>
        <p className="rounded-lg border bg-background px-3 py-4 text-center font-mono text-lg font-semibold tracking-wider">
          {state.backupRecoveryCode}
        </p>
        <Button className="w-full" onClick={acknowledge} type="button">
          Lo guardé
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      <Alert>
        <AlertTitle>Tu cuenta está lista</AlertTitle>
        <AlertDescription>Ya puedes vincular este navegador desde WhatsApp.</AlertDescription>
      </Alert>
      <Button className="w-full" render={<a href="/auth/pair">Ir a iniciar sesión</a>} />
    </div>
  );
};

type EmailOnboardingViewProps = Readonly<{
  acknowledge: () => void;
  restart: () => void;
  state: EmailOnboardingViewState;
  verify: (combinedCode: string) => void;
}>;

/** Pure first-party onboarding view at the feature's public testing seam. */
export const EmailOnboardingView = (onboarding: EmailOnboardingViewProps): JSX.Element => (
  <main className="flex min-h-svh items-center justify-center bg-muted/40 px-4 py-12">
    <Card className="w-full max-w-md">
      <CardHeader>
        <div className="mb-2 flex size-10 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <KeyRoundIcon aria-hidden="true" className="size-5" />
        </div>
        <CardTitle>
          <h1 className="text-2xl">Verifica tu correo</h1>
        </CardTitle>
        <CardDescription>Escribe el código completo que enviamos a tu correo.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <OnboardingState {...onboarding} />
      </CardContent>
    </Card>
  </main>
);

/** Stable first-party form; verification secrets never enter its URL or browser storage. */
export const EmailOnboardingFeature = (): JSX.Element => (
  <EmailOnboardingView {...useEmailOnboarding()} />
);
