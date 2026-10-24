import { EmailAddress, EmailVerificationCode } from "@/transport/client";
import { Clock, Effect, Option, Schema } from "effect";
import { type FormEvent, type JSX, useSyncExternalStore } from "react";
import {
  AccessAction,
  AccessAlternatives,
  AccessBack,
  AccessCode,
  AccessHeading,
  AccessInput,
  type AccessMethod,
} from "@/ui/components/access";
import { Spinner } from "@/ui/components/spinner";
import { type BrowserLoginPairing, invalidPairingMessage } from "./pairing-controller";
import { browserLoginPairingWhatsAppUrl } from "./whatsapp-link";

const millisecondsPerSecond = 1000;
const secondsPerMinute = 60;
const subscribeClock = (changed: () => void): (() => void) => {
  const timer = window.setInterval(changed, millisecondsPerSecond);
  return () => window.clearInterval(timer);
};
const currentSecond = (): number =>
  Math.floor(Effect.runSync(Clock.currentTimeMillis) / millisecondsPerSecond);
const Remaining = ({ deadline }: Readonly<{ deadline: number }>): JSX.Element => {
  const now = useSyncExternalStore(subscribeClock, currentSecond);
  const remaining = Math.max(0, Math.ceil(deadline / millisecondsPerSecond) - now);
  return (
    <>
      {Math.floor(remaining / secondsPerMinute)
        .toString()
        .padStart(2, "0")}
      :{(remaining % secondsPerMinute).toString().padStart(2, "0")}
    </>
  );
};
const EmailForm = ({ pairing }: Readonly<{ pairing: BrowserLoginPairing }>): JSX.Element => {
  const busy =
    pairing.state._tag === "Starting" ||
    (pairing.state._tag === "AwaitingApproval" && pairing.state.emailStep === "sending");
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const email = Schema.decodeUnknownOption(EmailAddress)(
      new FormData(event.currentTarget).get("email")
    );
    if (Option.isSome(email)) pairing.requestEmail(email.value);
  };
  return (
    <>
      <AccessHeading method="email">Entra con tu correo</AccessHeading>
      <p data-access-intro="">Usa el correo que ya verificaste en Fidy.</p>
      <form onSubmit={submit}>
        <label htmlFor="browser-login-email">Correo verificado</label>
        <AccessInput
          autoComplete="email"
          id="browser-login-email"
          name="email"
          placeholder="tu@correo.com"
          required
          type="email"
          disabled={busy}
        />
        <p data-access-helper="">
          Puede ser distinto del correo de Google o Microsoft con el que creaste tu cuenta.
        </p>
        <AccessAction kind="primary" disabled={busy} type="submit">
          {busy ? <Spinner /> : null}Enviar código
        </AccessAction>
      </form>
    </>
  );
};
const EmailCodeActions = ({
  pairing,
  busy,
  deadline,
}: Readonly<{ pairing: BrowserLoginPairing; busy: boolean; deadline: number }>): JSX.Element => {
  const now = useSyncExternalStore(subscribeClock, currentSecond);
  return (
    <div data-access-meta="">
      {deadline > now * millisecondsPerSecond ? (
        <span>
          Podrás reenviarlo en <Remaining deadline={deadline} />
        </span>
      ) : (
        <AccessAction kind="link" disabled={busy} onClick={pairing.resendEmail} type="button">
          Reenviar código
        </AccessAction>
      )}
      <AccessAction kind="link" disabled={busy} onClick={pairing.cancel} type="button">
        Cambiar correo
      </AccessAction>
    </div>
  );
};
const EmailCodeForm = ({ pairing }: Readonly<{ pairing: BrowserLoginPairing }>): JSX.Element => {
  if (pairing.state._tag !== "AwaitingApproval") return <></>;
  const { emailStep, emailRetryAt } = pairing.state;
  const busy = emailStep === "submitting" || emailStep === "sending";
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const code = Option.flatMap(
      Schema.decodeUnknownOption(Schema.String)(
        new FormData(event.currentTarget).get("combinedCode")
      ),
      (value) => Schema.decodeOption(EmailVerificationCode)(value.trim().toUpperCase())
    );
    if (Option.isSome(code)) pairing.completeEmail(code.value);
  };
  return (
    <>
      <AccessHeading method="email">Revisa tu correo</AccessHeading>
      <p data-access-intro="">
        Si tu correo está verificado en Fidy, recibirás un código para entrar.
      </p>
      <form onSubmit={submit}>
        <label htmlFor="browser-login-email-code">Código del correo</label>
        <AccessInput
          id="browser-login-email-code"
          name="combinedCode"
          autoCapitalize="characters"
          autoComplete="one-time-code"
          placeholder="XXXX-XXXX-XXXX-XXXX-XXXX-XXXX"
          disabled={busy}
          required
          aria-invalid={emailStep === "rejected"}
          aria-describedby={
            emailStep === "rejected" ? "browser-login-code-error" : "browser-login-code-help"
          }
        />
        <p data-access-helper="" id="browser-login-code-help">
          Pega el código completo de 24 caracteres.
        </p>
        {emailStep === "rejected" ? (
          <p role="alert" id="browser-login-code-error" data-access-error="">
            No pudimos validar ese código. Revísalo o solicita uno nuevo.
          </p>
        ) : null}
        <AccessAction kind="primary" disabled={busy} type="submit">
          {busy ? <Spinner /> : null}Confirmar y entrar
        </AccessAction>
        <EmailCodeActions pairing={pairing} busy={busy} deadline={emailRetryAt} />
      </form>
    </>
  );
};
type PairingViewProps = Readonly<{
  method: "email" | "whatsapp";
  pairing: BrowserLoginPairing;
  choose: (method: AccessMethod | "principal") => void;
}>;
const TerminalStatus = ({ method, pairing, choose }: PairingViewProps): JSX.Element => {
  const { state } = pairing;
  const expired = state._tag === "Expired";
  return (
    <>
      <AccessHeading method={method}>
        {expired ? "El código venció" : "Acceso no autorizado"}
      </AccessHeading>
      <p data-access-intro="">
        {expired
          ? "La solicitud de acceso ya no está activa. Genera otro código para continuar."
          : invalidPairingMessage}
      </p>
      {state._tag === "Expired" && method === "whatsapp" ? (
        <AccessCode code={state.publicCode} expired />
      ) : null}
      <AccessAction kind="primary" onClick={() => choose(method)}>
        {expired ? "Generar otro código" : "Iniciar otra solicitud"}
      </AccessAction>
    </>
  );
};
const WhatsAppStatus = ({ pairing }: Pick<PairingViewProps, "pairing">): JSX.Element => {
  const { state } = pairing;
  return (
    <>
      <AccessHeading method="whatsapp">
        Confirma por <span className="sr-only">WhatsApp</span>
      </AccessHeading>
      <p data-access-intro="">
        Abre el chat de Fidy desde el WhatsApp que ya tienes vinculado y confirma este código.
      </p>
      {state._tag === "AwaitingApproval" ? (
        <>
          <AccessCode code={state.publicCode} expired={false} />
          <div data-access-meta="">
            Válido durante <Remaining deadline={state.expiresAt} />
          </div>
          <AccessAction
            kind="primary"
            aria-label="Abrir WhatsApp"
            render={
              <a
                aria-label="Abrir WhatsApp"
                href={browserLoginPairingWhatsAppUrl(state.publicCode)}
                rel="noreferrer"
              />
            }
          >
            Abrir WhatsApp
          </AccessAction>
          <p data-access-wait="" aria-live="polite">
            Esperando tu confirmación
          </p>
          <p data-access-helper="">Esta página continuará cuando apruebes el acceso.</p>
        </>
      ) : (
        <output>
          <Spinner /> Iniciando vinculación segura…
        </output>
      )}
    </>
  );
};
const PairingContent = (props: PairingViewProps): JSX.Element => {
  const { method, pairing } = props;
  const { state } = pairing;
  if (state._tag === "Invalid" || state._tag === "Expired") return <TerminalStatus {...props} />;
  if (method === "whatsapp") return <WhatsAppStatus pairing={pairing} />;
  if (
    state._tag === "AwaitingApproval" &&
    state.emailStep !== "ready" &&
    state.emailStep !== "sending"
  ) {
    return <EmailCodeForm pairing={pairing} />;
  }
  return <EmailForm pairing={pairing} />;
};
export const BrowserLoginPairingFeature = (props: PairingViewProps): JSX.Element => (
  <div data-access-flow="">
    <AccessBack onClick={() => props.choose("principal")} />
    <PairingContent {...props} />
    <AccessAlternatives exclude={props.method} choose={props.choose} />
  </div>
);
