import { Mail01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type FormEvent, type JSX, useState } from "react";
import { Link } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import type { EmailAddress } from "@/transport/client";
import { Spinner } from "@/ui/components/spinner";
import { type EmailReplacementViewState, useEmailReplacement } from "./controller";

type EmailReplacementViewProps = Readonly<{
  state: EmailReplacementViewState;
  request: (candidateEmail: string) => void;
  complete: (candidateEmail: EmailAddress, combinedCode: string) => void;
  restart: () => void;
}>;

const ReplacementForm = ({ request }: Pick<EmailReplacementViewProps, "request">): JSX.Element => {
  const [candidateEmail, setCandidateEmail] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    request(candidateEmail);
  };
  return (
    <form className="settings-email-form" onSubmit={submit}>
      <div className="flex flex-col gap-2">
        <Label htmlFor="candidate-email">Nuevo correo</Label>
        <Input
          autoComplete="email"
          id="candidate-email"
          maxLength={320}
          onChange={(event) => setCandidateEmail(event.target.value)}
          placeholder="tu-nuevo-correo@ejemplo.com"
          required
          type="email"
          value={candidateEmail}
        />
      </div>
      <Button disabled={candidateEmail.length === 0} type="submit">
        Enviar código
      </Button>
    </form>
  );
};

const ProofForm = ({
  candidateEmail,
  complete,
  invalid,
  request,
  restart,
}: Readonly<{
  candidateEmail: EmailAddress;
  complete: EmailReplacementViewProps["complete"];
  invalid: boolean;
  request: EmailReplacementViewProps["request"];
  restart: () => void;
}>): JSX.Element => {
  const [combinedCode, setCombinedCode] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    complete(candidateEmail, combinedCode);
    setCombinedCode("");
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      {invalid ? (
        <Alert variant="destructive">
          <AlertTitle>El código no es válido</AlertTitle>
          <AlertDescription>Revisa el correo o solicita otro código.</AlertDescription>
        </Alert>
      ) : null}
      <p className="text-sm text-muted-foreground">Enviamos un código a {candidateEmail}.</p>
      <div className="flex flex-col gap-2">
        <Label htmlFor="replacement-code">Código de verificación</Label>
        <Input
          autoCapitalize="characters"
          autoComplete="one-time-code"
          autoCorrect="off"
          id="replacement-code"
          maxLength={29}
          onChange={(event) => setCombinedCode(event.target.value.toUpperCase())}
          placeholder="ABCD-2345-F7KM-9Q2D-X4PT-6RWC"
          spellCheck={false}
          value={combinedCode}
        />
      </div>
      <Button disabled={combinedCode.length === 0} type="submit">
        Cambiar correo
      </Button>
      <Button onClick={() => request(candidateEmail)} type="button" variant="outline">
        Reenviar código
      </Button>
      <Button onClick={restart} type="button" variant="outline">
        Usar otro correo
      </Button>
    </form>
  );
};

const ReplacementUnavailable = (): JSX.Element => (
  <Alert>
    <AlertTitle>No pudimos confirmar el cambio de correo</AlertTitle>
    <AlertDescription>
      El cambio podría haberse completado. Comprueba tu correo al iniciar sesión antes de solicitar
      otro cambio.{" "}
      <Link className="underline" to="/login" reloadDocument search={{ resume: "account" }}>
        Ir a vinculación
      </Link>
      .
    </AlertDescription>
  </Alert>
);

const replacementContent = ({
  complete,
  request,
  restart,
  state,
}: EmailReplacementViewProps): JSX.Element => {
  if (state._tag === "Editing") return <ReplacementForm request={request} />;
  if (state._tag === "Requesting" || state._tag === "Completing") {
    return (
      <Button disabled type="button">
        <Spinner /> Procesando…
      </Button>
    );
  }
  if (state._tag === "AwaitingCode" || state._tag === "Invalid") {
    return (
      <ProofForm
        candidateEmail={state.candidateEmail}
        complete={complete}
        invalid={state._tag === "Invalid"}
        request={request}
        restart={restart}
      />
    );
  }
  if (state._tag === "FreshPairingRequired") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Vincula el navegador de nuevo</AlertTitle>
        <AlertDescription>
          Por seguridad, necesitas una sesión recién vinculada para cambiar tu correo.{" "}
          <Link className="underline" to="/login" reloadDocument search={{ resume: "account" }}>
            Ir a vinculación
          </Link>
          .
        </AlertDescription>
      </Alert>
    );
  }
  if (state._tag === "Unavailable") {
    return <ReplacementUnavailable />;
  }
  state satisfies Extract<EmailReplacementViewState, { _tag: "Replaced" }>;
  return (
    <Alert>
      <AlertTitle>Correo actualizado</AlertTitle>
      <AlertDescription>Tu nuevo correo verificado ya está activo.</AlertDescription>
    </Alert>
  );
};

/** Mailbox proofs stay in transient form state and request bodies. */
export const EmailReplacementView = (props: EmailReplacementViewProps): JSX.Element => (
  <section aria-label="Correo de acceso" className="settings-section">
    <div className="settings-section-icon" aria-hidden="true">
      <HugeiconsIcon icon={Mail01Icon} size={30} strokeWidth={1.5} />
    </div>
    <div className="settings-section-body">
      <h2 className="settings-section-title">Correo verificado</h2>
      <p className="settings-section-description">
        Si ya tienes un correo verificado, seguirá activo hasta verificar el nuevo.
        <br />
        Iniciar sesión con Google o Microsoft no establece este correo.
      </p>
      <div className="settings-section-actions">{replacementContent(props)}</div>
    </div>
  </section>
);

export const EmailReplacementFeature = (): JSX.Element => (
  <EmailReplacementView {...useEmailReplacement()} />
);
