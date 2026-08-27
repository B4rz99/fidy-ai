import { EmailAddress, EmailVerificationCode } from "@/transport/client";
import { Option, Schema } from "effect";
import { KeyRoundIcon, MessageCircleIcon } from "lucide-react";
import type { FormEvent, JSX } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Button } from "@/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/ui/components/card";
import { Input } from "@/ui/components/input";
import { Spinner } from "@/ui/components/spinner";
import {
  type BrowserLoginPairingViewState,
  invalidPairingMessage,
  useBrowserLoginPairing,
} from "./pairing-controller";
import { browserLoginPairingWhatsAppUrl } from "./whatsapp-link";

type VerifiedEmailAddress = EmailAddress;
type VerifiedEmailCombinedCode = EmailVerificationCode;

type PairingStatusProps = Readonly<{
  state: BrowserLoginPairingViewState;
  onStart: () => void;
  onRestart: () => void;
  onLogout: () => void;
  onRequestEmail: (email: VerifiedEmailAddress) => void;
  onResendEmail: () => void;
  onCompleteEmail: (combinedCode: VerifiedEmailCombinedCode) => void;
}>;

type EmailApprovalProps = Readonly<{
  emailStep: Extract<BrowserLoginPairingViewState, { _tag: "AwaitingApproval" }>["emailStep"];
  onRequestEmail: (email: VerifiedEmailAddress) => void;
  onResendEmail: () => void;
  onCompleteEmail: (combinedCode: VerifiedEmailCombinedCode) => void;
}>;

const EmailRequestForm = ({
  sending,
  onRequestEmail,
}: Readonly<{
  sending: boolean;
  onRequestEmail: (email: VerifiedEmailAddress) => void;
}>): JSX.Element => {
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const email = Schema.decodeUnknownOption(EmailAddress)(
      new FormData(event.currentTarget).get("email")
    );
    if (email._tag === "Some") onRequestEmail(email.value);
  };
  return (
    <form className="space-y-2" onSubmit={submit}>
      <label className="text-sm font-medium" htmlFor="browser-login-email">
        O accede con tu correo verificado
      </label>
      <Input
        autoComplete="email"
        disabled={sending}
        id="browser-login-email"
        name="email"
        placeholder="tu@correo.com"
        required
        type="email"
      />
      <Button className="w-full" disabled={sending} type="submit" variant="outline">
        {sending ? <Spinner /> : null}
        Enviar código por correo
      </Button>
    </form>
  );
};

const EmailCodeForm = ({
  emailStep,
  onCompleteEmail,
  onResendEmail,
}: Pick<EmailApprovalProps, "emailStep" | "onCompleteEmail" | "onResendEmail">): JSX.Element => {
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const code = Option.flatMap(
      Schema.decodeUnknownOption(Schema.String)(
        new FormData(event.currentTarget).get("combinedCode")
      ),
      (value) => Schema.decodeUnknownOption(EmailVerificationCode)(value.trim().toUpperCase())
    );
    if (code._tag === "Some") onCompleteEmail(code.value);
  };
  const rejected = emailStep === "rejected";
  const submitting = emailStep === "submitting";
  return (
    <form className="space-y-2" onSubmit={submit}>
      <label className="text-sm font-medium" htmlFor="browser-login-email-code">
        Código recibido por correo
      </label>
      <Input
        aria-describedby={rejected ? "browser-login-code-error" : undefined}
        autoCapitalize="characters"
        autoComplete="one-time-code"
        disabled={submitting}
        id="browser-login-email-code"
        name="combinedCode"
        placeholder="ABCD-EFGH-JKLM-NPQR-STUV-WXYZ"
        required
      />
      {rejected ? (
        <p className="text-sm text-destructive" id="browser-login-code-error" role="alert">
          El código no es válido. Revisa el correo o solicita uno nuevo.
        </p>
      ) : null}
      <Button className="w-full" disabled={submitting} type="submit" variant="outline">
        {submitting ? <Spinner /> : null}
        Aprobar este navegador
      </Button>
      <Button
        className="w-full"
        disabled={submitting}
        onClick={onResendEmail}
        type="button"
        variant="ghost"
      >
        Solicitar otro código al mismo correo
      </Button>
    </form>
  );
};

const EmailApproval = ({
  emailStep,
  onCompleteEmail,
  onRequestEmail,
  onResendEmail,
}: EmailApprovalProps): JSX.Element =>
  emailStep === "ready" || emailStep === "sending" ? (
    <EmailRequestForm onRequestEmail={onRequestEmail} sending={emailStep === "sending"} />
  ) : (
    <EmailCodeForm
      emailStep={emailStep}
      onCompleteEmail={onCompleteEmail}
      onResendEmail={onResendEmail}
    />
  );

const AwaitingPairing = ({
  emailStep,
  onCompleteEmail,
  onRequestEmail,
  onResendEmail,
  publicCode,
}: Readonly<{
  publicCode: string;
  emailStep: Extract<BrowserLoginPairingViewState, { _tag: "AwaitingApproval" }>["emailStep"];
  onRequestEmail: (email: VerifiedEmailAddress) => void;
  onResendEmail: () => void;
  onCompleteEmail: (combinedCode: VerifiedEmailCombinedCode) => void;
}>): JSX.Element => (
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
    <div aria-hidden="true" className="border-t" />
    <EmailApproval
      emailStep={emailStep}
      onCompleteEmail={onCompleteEmail}
      onRequestEmail={onRequestEmail}
      onResendEmail={onResendEmail}
    />
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
  onRequestEmail,
  onResendEmail,
  onCompleteEmail,
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
      return (
        <AwaitingPairing
          emailStep={state.emailStep}
          onCompleteEmail={onCompleteEmail}
          onRequestEmail={onRequestEmail}
          onResendEmail={onResendEmail}
          publicCode={state.publicCode}
        />
      );
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
            onCompleteEmail={pairing.completeEmail}
            onLogout={pairing.logout}
            onRequestEmail={pairing.requestEmail}
            onResendEmail={pairing.resendEmail}
            onRestart={pairing.restart}
            onStart={pairing.start}
            state={pairing.state}
          />
        </CardContent>
      </Card>
    </main>
  );
};
