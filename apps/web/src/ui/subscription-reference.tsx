import { CreditCardIcon, Mail01Icon, SmartPhone01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, useState } from "react";
import { Button } from "@/ui/components/button";
import { Checkbox } from "@/ui/components/checkbox";
import { Input } from "@/ui/components/input";
import { SubscriptionInputDecoration } from "@/ui/components/subscription-input-decoration";
import "@/ui/components/subscription.css";

const examplePeriods = ["Semanal", "Mensual", "Anual"] as const;
const exampleMethods = ["Tarjeta", "Nequi", "DaviPlata"] as const;
const PeriodExample = (): JSX.Element => {
  const [period, select] = useState("");
  return (
    <div className="subscription-offers" aria-label="Períodos de ejemplo">
      {examplePeriods.map((choice) => (
        <div key={choice} className="subscription-offer">
          <Button
            type="button"
            variant="ghost"
            aria-pressed={period === choice}
            onClick={() => select(choice)}
          >
            <span className="subscription-offer-label">
              <span className="subscription-choice-dot" aria-hidden="true" />
              {choice}
            </span>
            <span className="subscription-offer-period">Período de ejemplo</span>
          </Button>
        </div>
      ))}
    </div>
  );
};
const MethodExample = (): JSX.Element => {
  const [method, select] = useState("Tarjeta");
  return (
    <div className="subscription-methods" aria-label="Métodos de ejemplo">
      {exampleMethods.map((choice) => (
        <Button
          key={choice}
          variant="outline"
          type="button"
          aria-pressed={method === choice}
          onClick={() => select(choice)}
        >
          <HugeiconsIcon
            icon={choice === "Tarjeta" ? CreditCardIcon : SmartPhone01Icon}
            size={24}
            aria-hidden="true"
          />
          {choice}
        </Button>
      ))}
    </div>
  );
};
const ConsentExample = (): JSX.Element => {
  const [accepted, accept] = useState(false);
  return (
    <div className="subscription-form">
      <label className="subscription-field" htmlFor="subscription-reference-email">
        Correo de ejemplo
        <SubscriptionInputDecoration icon={Mail01Icon}>
          <Input id="subscription-reference-email" placeholder="tu-correo@ejemplo.com" disabled />
        </SubscriptionInputDecoration>
      </label>
      <div className="subscription-consents">
        <label className="subscription-consent" htmlFor="subscription-reference-consent">
          <Checkbox
            id="subscription-reference-consent"
            checked={accepted}
            onCheckedChange={accept}
          />
          <span>Confirmo la opción de ejemplo. No autoriza ningún pago.</span>
        </label>
      </div>
      <Button type="button" disabled={!accepted}>
        Acción de ejemplo
      </Button>
    </div>
  );
};
export const SubscriptionReference = (): JSX.Element => (
  <section id="subscription" aria-labelledby="subscription-reference-title">
    <p className="mb-4 text-sm text-muted-foreground">
      Referencia de Suscripción: controles locales sin precios, datos personales ni operaciones de
      pago. Prueba el foco con Tab y Espacio.
    </p>
    <div className="subscription-workspace">
      <header className="subscription-header">
        <h2 id="subscription-reference-title">Suscripción y pagos</h2>
      </header>
      <div className="subscription-columns">
        <div className="subscription-main">
          <PeriodExample />
          <MethodExample />
          <ConsentExample />
        </div>
        <aside className="subscription-summary" aria-label="Ejemplo de contexto">
          <h2>Tu elección</h2>
          <p>
            El contexto acompaña a la selección, sin convertir una autorización en un pago aprobado.
          </p>
        </aside>
      </div>
    </div>
  </section>
);
