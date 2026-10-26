import { Mail01Icon } from "@hugeicons/core-free-icons";
import { type JSX, useId } from "react";
import { Checkbox } from "@/ui/components/checkbox";
import { Input } from "@/ui/components/input";
import { SubscriptionInputDecoration } from "@/ui/components/subscription-input-decoration";
import { type PreparedEnrollment } from "./enrollment-gateway";

import { type EnrollmentDecisions } from "./enrollment-decisions";

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
}>): JSX.Element => {
  const id = useId();
  return (
    <div className="subscription-consents">
      <label className="subscription-consent" htmlFor={`${id}-end-user-policy`}>
        <Checkbox
          id={`${id}-end-user-policy`}
          checked={decisions.endUserPolicy}
          disabled={disabled}
          onCheckedChange={(checked) => setDecisions({ ...decisions, endUserPolicy: checked })}
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
      <label className="subscription-consent" htmlFor={`${id}-personal-data`}>
        <Checkbox
          id={`${id}-personal-data`}
          checked={decisions.personalData}
          disabled={disabled}
          onCheckedChange={(checked) => setDecisions({ ...decisions, personalData: checked })}
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
};
export const BillingEmailField = ({
  email,
  disabled,
  setEmail,
}: Readonly<{
  email: string;
  disabled: boolean;
  setEmail: (email: string) => void;
}>): JSX.Element => (
  <label className="subscription-field" htmlFor="billing-email">
    Correo de facturación
    <SubscriptionInputDecoration icon={Mail01Icon}>
      <Input
        id="billing-email"
        autoComplete="email"
        disabled={disabled}
        placeholder="tu-correo@ejemplo.com"
        required
        type="email"
        value={email}
        onChange={(event) => setEmail(event.target.value)}
      />
    </SubscriptionInputDecoration>
  </label>
);
