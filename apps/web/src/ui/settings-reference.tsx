import { Mail01Icon, Shield01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { type JSX, useState } from "react";
import { Button } from "@/ui/components/button";
import { Checkbox } from "@/ui/components/checkbox";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import "@/ui/components/application.css";
import "@/ui/components/settings.css";

const EmailExample = (): JSX.Element => (
  <section className="settings-section">
    <div className="settings-section-icon" aria-hidden="true">
      <HugeiconsIcon icon={Mail01Icon} size={30} strokeWidth={1.5} />
    </div>
    <div className="settings-section-body">
      <h3 className="settings-section-title">Correo verificado</h3>
      <p className="settings-section-description">
        Campo y acción de ejemplo, sin envío de correo.
      </p>
      <div className="settings-section-actions">
        <div className="settings-email-form">
          <div className="flex flex-col gap-2">
            <Label htmlFor="settings-reference-email">Nuevo correo de ejemplo</Label>
            <Input id="settings-reference-email" type="email" placeholder="tu-correo@ejemplo.com" />
          </div>
          <Button type="button" disabled>
            Enviar código
          </Button>
        </div>
      </div>
    </div>
  </section>
);

const AuthorizationExample = (): JSX.Element => {
  const [confirmed, confirm] = useState(false);
  const [submitted, submit] = useState(false);
  return (
    <section className="settings-section">
      <div className="settings-section-icon" aria-hidden="true">
        <HugeiconsIcon icon={Shield01Icon} size={30} strokeWidth={1.5} />
      </div>
      <div className="settings-section-body">
        <h3 className="settings-section-title">Autorización de ejemplo</h3>
        <p className="settings-section-description">
          Prueba el foco y los estados con Tab y Espacio.
        </p>
        <div className="settings-section-actions">
          <label className="flex items-center gap-3" htmlFor="settings-reference-confirmation">
            <Checkbox
              id="settings-reference-confirmation"
              checked={confirmed}
              onCheckedChange={confirm}
            />
            Confirmar la acción de ejemplo.
          </label>
          <div>
            <Button
              type="button"
              variant="destructive-outline"
              disabled={!confirmed}
              onClick={() => submit(true)}
            >
              Retirar autorización de ejemplo
            </Button>
          </div>
          {submitted ? (
            <output>Ejemplo completado. No se cambió ninguna autorización.</output>
          ) : null}
        </div>
      </div>
    </section>
  );
};

const TokenExample = (): JSX.Element => {
  const [selected, select] = useState(true);
  return (
    <aside className="settings-panel">
      <div className="settings-token-creation">
        <h3 className="settings-panel-title">Permisos de ejemplo</h3>
        <label className="settings-scope-option" htmlFor="settings-reference-scope">
          <Checkbox id="settings-reference-scope" checked={selected} onCheckedChange={select} />
          <span>
            <span className="block font-medium">Lectura</span>
            <span className="text-sm text-muted-foreground">Consultar tus datos financieros.</span>
          </span>
        </label>
        <Button
          type="button"
          variant="destructive-text"
          size="label"
          disabled={!selected}
          onClick={() => select(false)}
        >
          Desactivar permiso de ejemplo
        </Button>
      </div>
    </aside>
  );
};

export const SettingsReference = (): JSX.Element => (
  <section id="settings" aria-labelledby="settings-reference-heading">
    <p className="mb-4 text-sm text-muted-foreground">
      Referencia de Ajustes: controles y panel adaptables. No modifica datos ni crea credenciales.
    </p>
    <div className="application-shell settings-workspace">
      <header className="settings-header">
        <h2 id="settings-reference-heading">Ajustes</h2>
      </header>
      <div className="settings-columns">
        <div className="settings-main">
          <EmailExample />
          <AuthorizationExample />
        </div>
        <TokenExample />
      </div>
    </div>
  </section>
);
