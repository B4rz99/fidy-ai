import { type JSX } from "react";
import { Input } from "@/ui/components/input";
import { type PreparedEnrollment } from "./enrollment-gateway";

import { type EnrollmentDecisions } from "./enrollment-decisions";

/** Presents the same Wompi disclosures for each reusable-source authorization method. */
export const EnrollmentConsent = ({
  enrollment,
  decisions,
  disabled,
  setDecisions,
}: Readonly<{
  enrollment: PreparedEnrollment;
  decisions: EnrollmentDecisions;
  disabled: boolean;
  setDecisions: (decisions: EnrollmentDecisions) => void;
}>): JSX.Element => (
  <div className="flex flex-col gap-2">
    <label className="flex items-start gap-2">
      <input
        checked={decisions.endUserPolicy}
        disabled={disabled}
        onChange={(event) => setDecisions({ ...decisions, endUserPolicy: event.target.checked })}
        type="checkbox"
      />
      <span>
        Acepto el{" "}
        <a
          className="underline underline-offset-2"
          href={enrollment.contracts.endUserPolicy.permalink.href}
          rel="noreferrer"
          target="_blank"
        >
          reglamento
        </a>{" "}
        de Wompi.
      </span>
    </label>
    <label className="flex items-start gap-2">
      <input
        checked={decisions.personalData}
        disabled={disabled}
        onChange={(event) => setDecisions({ ...decisions, personalData: event.target.checked })}
        type="checkbox"
      />
      <span>
        Autorizo el{" "}
        <a
          className="underline underline-offset-2"
          href={enrollment.contracts.personalDataAuthorization.permalink.href}
          rel="noreferrer"
          target="_blank"
        >
          tratamiento de datos personales
        </a>{" "}
        de Wompi.
      </span>
    </label>
  </div>
);
/** Billing contact is Fidy state, unlike document/product details that travel only to Wompi. */
export const BillingEmailField = ({
  email,
  disabled,
  setEmail,
}: Readonly<{
  email: string;
  disabled: boolean;
  setEmail: (email: string) => void;
}>): JSX.Element => (
  <>
    <label className="flex flex-col gap-1" htmlFor="billing-email">
      Correo de facturación
      <Input
        id="billing-email"
        autoComplete="email"
        disabled={disabled}
        required
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
    </label>
    <p className="text-sm text-muted-foreground">
      Fidy conservará este correo y lo compartirá con Wompi para los cobros automáticos posteriores
      de tu fuente de pago reutilizable.
    </p>
  </>
);
