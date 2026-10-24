import { type JSX, useState } from "react";
import {
  AccessAction,
  AccessAlternatives,
  AccessBack,
  AccessCode,
  AccessHeading,
  AccessInput,
  type AccessMethod,
} from "./components/access";

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
    </section>
  );
};
