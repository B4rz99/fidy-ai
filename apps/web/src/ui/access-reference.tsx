import { type JSX, useState } from "react";
import {
  AccessAction,
  AccessAlternatives,
  AccessBack,
  AccessCode,
  AccessConsent,
  AccessHeading,
  AccessInput,
  type AccessMethod,
  AccessMethodIcon,
} from "@/ui/components/access";

const SignupReference = (): JSX.Element => {
  const [accepted, setAccepted] = useState(false);
  return (
    <div data-access-principal="" data-access-signup="" className="mx-auto max-w-md p-6">
      <h2 data-access-heading="">Crea tu cuenta</h2>
      <p data-access-intro="">Elige cómo crear tu cuenta.</p>
      <div data-access-consent="">
        <AccessConsent
          accepted={accepted}
          onAcceptedChange={setAccepted}
          policyUrl="https://app.fidyapp.com/politica"
        />
      </div>
      {(["google", "microsoft"] as const).map((method) => (
        <AccessAction key={method} kind="provider" disabled={!accepted}>
          <AccessMethodIcon method={method} />
          Continuar con {method === "google" ? "Google" : "Microsoft"}
        </AccessAction>
      ))}
      <p data-access-helper="">Ejemplo local; no acepta acuerdos ni crea cuentas.</p>
    </div>
  );
};

export const AccessReference = ({ dark }: Readonly<{ dark: boolean }>): JSX.Element => {
  const [method, setMethod] = useState<AccessMethod>("email");
  return (
    <section
      id="access"
      aria-label="Controles de acceso aprobados"
      data-access-root=""
      className={dark ? "dark" : ""}
    >
      <div className="mx-auto max-w-md p-6">
        <AccessBack onClick={() => setMethod("email")} />
        <AccessHeading method={method}>Acceso de ejemplo</AccessHeading>
        <label htmlFor="access-reference-email">Correo verificado</label>
        <AccessInput id="access-reference-email" type="email" placeholder="tu@correo.com" />
        <p data-access-helper="">Ejemplo local de controles; no inicia sesión ni envía mensajes.</p>
        <AccessCode code="BCDF-GHJK" expired={false} />
        <AccessAction kind="primary" disabled>
          Confirmar y entrar
        </AccessAction>
        <AccessAlternatives exclude={method} choose={setMethod} />
      </div>
      <SignupReference />
    </section>
  );
};
