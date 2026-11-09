import { Mail01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type FormEvent, type JSX, type RefCallback, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/ui/components/alert";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import type { EmailAddress } from "@/transport/client";
import { Spinner } from "@/ui/components/spinner";

export type EmailReplacementViewState =
  | Readonly<{ _tag: "Editing"; feedback: "none" | "invalid-candidate" | "request-unavailable" }>
  | Readonly<{ _tag: "Requesting"; candidateEmail: EmailAddress }>
  | Readonly<{ _tag: "AwaitingCode"; candidateEmail: EmailAddress }>
  | Readonly<{ _tag: "Completing"; candidateEmail: EmailAddress }>
  | Readonly<{ _tag: "InvalidCode"; candidateEmail: EmailAddress }>
  | Readonly<{ _tag: "FreshPairingRequired" }>
  | Readonly<{ _tag: "Replaced" }>
  | Readonly<{ _tag: "Uncertain" }>
  | Readonly<{ _tag: "Disposed" }>;

type EmailReplacementViewProps = Readonly<{
  state: EmailReplacementViewState;
  request: (candidateEmail: string) => void;
  complete: (combinedCode: string) => void;
  repeat: () => void;
  lifecycleRef: RefCallback<HTMLElement>;
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
      <Button contentLayout="wrap" disabled={candidateEmail.length === 0} type="submit">
        Enviar código
      </Button>
    </form>
  );
};

const ProofForm = ({
  candidateEmail,
  complete,
  invalid,
  repeat,
  restart,
}: Readonly<{
  candidateEmail: EmailAddress;
  complete: EmailReplacementViewProps["complete"];
  invalid: boolean;
  repeat: () => void;
  restart: () => void;
}>): JSX.Element => {
  const [combinedCode, setCombinedCode] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const submittedCode = combinedCode;
    setCombinedCode("");
    complete(submittedCode);
  };
  return (
    <form className="flex flex-col gap-4" onSubmit={submit}>
      {invalid ? (
        <Alert variant="destructive">
          <AlertTitle>El código no es válido</AlertTitle>
          <AlertDescription>Revisa el código del correo que recibiste.</AlertDescription>
        </Alert>
      ) : null}
      <p className="text-sm text-muted-foreground">
        Si recibes un código para {candidateEmail}, puedes ingresarlo aquí.
      </p>
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
      <Button contentLayout="wrap" disabled={combinedCode.length === 0} type="submit">
        Cambiar correo
      </Button>
      <Button contentLayout="wrap" onClick={repeat} type="button" variant="outline">
        Solicitar código de nuevo
      </Button>
      <Button contentLayout="wrap" onClick={restart} type="button" variant="outline">
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
      <a className="underline" href="/login?resume=account">
        Ir a vinculación
      </a>
      .
    </AlertDescription>
  </Alert>
);

const EditingForm = ({
  request,
  state,
}: Pick<EmailReplacementViewProps, "request"> &
  Readonly<{ state: Extract<EmailReplacementViewState, { _tag: "Editing" }> }>): JSX.Element => (
  <>
    {state.feedback !== "none" ? (
      <Alert variant="destructive">
        <AlertDescription>
          {state.feedback === "invalid-candidate"
            ? "Ingresa un correo válido."
            : "No pudimos confirmar la solicitud. Puedes solicitar el código de nuevo."}
        </AlertDescription>
      </Alert>
    ) : null}
    <ReplacementForm request={request} />
  </>
);
const ReplacementWaiting = ({
  restart,
}: Pick<EmailReplacementViewProps, "restart">): JSX.Element => (
  <div className="flex flex-col gap-4">
    <Button contentLayout="wrap" disabled type="button">
      <Spinner /> Procesando…
    </Button>
    <Button contentLayout="wrap" onClick={restart} type="button" variant="outline">
      Volver
    </Button>
  </div>
);
const replacementContent = ({
  complete,
  request,
  repeat,
  restart,
  state,
}: Omit<EmailReplacementViewProps, "lifecycleRef">): JSX.Element => {
  if (state._tag === "Editing") return <EditingForm request={request} state={state} />;
  if (state._tag === "Requesting" || state._tag === "Completing") {
    return <ReplacementWaiting restart={restart} />;
  }
  if (state._tag === "AwaitingCode" || state._tag === "InvalidCode") {
    return (
      <ProofForm
        candidateEmail={state.candidateEmail}
        complete={complete}
        invalid={state._tag === "InvalidCode"}
        repeat={repeat}
        restart={restart}
      />
    );
  }
  return replacementOutcome(state);
};
const replacementOutcome = (
  state: Extract<
    EmailReplacementViewState,
    { _tag: "FreshPairingRequired" | "Uncertain" | "Disposed" | "Replaced" }
  >
): JSX.Element => {
  if (state._tag === "FreshPairingRequired") {
    return (
      <Alert variant="destructive">
        <AlertTitle>Vincula el navegador de nuevo</AlertTitle>
        <AlertDescription>
          Por seguridad, necesitas una sesión recién vinculada para cambiar tu correo.{" "}
          <a className="underline" href="/login?resume=account">
            Ir a vinculación
          </a>
          .
        </AlertDescription>
      </Alert>
    );
  }
  if (state._tag === "Uncertain" || state._tag === "Disposed") {
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
export const EmailReplacementView = ({
  lifecycleRef,
  ...props
}: EmailReplacementViewProps): JSX.Element => (
  <section aria-label="Correo de acceso" className="settings-section" ref={lifecycleRef}>
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
