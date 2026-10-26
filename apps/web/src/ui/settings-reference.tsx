import { ArrowUpRight01Icon, Mail01Icon, Shield01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Option } from "effect";
import { type JSX, useState } from "react";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { Checkbox } from "@/ui/components/checkbox";
import { ChoiceDropdown } from "@/ui/components/choice-dropdown";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/components/table";
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
        <div className="settings-section-heading">
          <h3 className="settings-section-title">Autorización de ejemplo</h3>
          <Badge variant="success">Vigente</Badge>
        </div>
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
  const [lifetime, selectLifetime] = useState("30");
  return (
    <div className="settings-panel">
      <div className="settings-token-creation">
        <h3 className="settings-panel-title">Permisos de ejemplo</h3>
        <label className="settings-scope-option" htmlFor="settings-reference-scope">
          <Checkbox id="settings-reference-scope" checked={selected} onCheckedChange={select} />
          <span>
            <span className="block font-medium">Lectura</span>
            <span className="text-sm text-muted-foreground">Consultar tus datos financieros.</span>
          </span>
        </label>
        <fieldset className="settings-token-lifetime">
          <legend className="font-medium">Duración de ejemplo</legend>
          <ChoiceDropdown
            id="settings-reference-lifetime"
            label="Duración de ejemplo"
            width="full"
            disabled={false}
            leading={null}
            triggerLabel={Option.none()}
            options={[
              { value: "7", label: "7 días" },
              { value: "30", label: "30 días" },
            ]}
            value={lifetime}
            onChange={selectLifetime}
          />
        </fieldset>
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
    </div>
  );
};

const managementExampleDetails = [
  { label: "Permisos", value: "Lectura · Escritura" },
  { label: "Estado", value: <Badge variant="success">Activo</Badge> },
  { label: "Vence", value: <time dateTime="2026-11-23T00:00:00Z">23 nov 2026</time> },
];
const ManagementExampleAction = (): JSX.Element => (
  <Button type="button" variant="destructive-text" size="label" disabled>
    Desactivar ejemplo
  </Button>
);
const ManagementExampleTable = (): JSX.Element => (
  <div className="settings-table" data-settings-desktop>
    <Table aria-labelledby="settings-reference-table-title">
      <TableHeader>
        <TableRow>
          {["Nombre", "Permisos", "Estado", "Vence", "Acción"].map((label) => (
            <TableHead key={label} scope="col" density="compact">
              {label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableHead scope="row" density="compact" className="whitespace-normal">
            Agente de ejemplo
          </TableHead>
          {managementExampleDetails.map(({ label, value }) => (
            <TableCell key={label} density="compact">
              {value}
            </TableCell>
          ))}
          <TableCell density="compact">
            <ManagementExampleAction />
          </TableCell>
        </TableRow>
      </TableBody>
    </Table>
  </div>
);
const ManagementExample = (): JSX.Element => (
  <section className="settings-access-section" aria-labelledby="settings-reference-table-title">
    <h3 id="settings-reference-table-title" className="settings-section-title">
      Acceso de ejemplo
    </h3>
    <ManagementExampleTable />
    <ul data-settings-mobile-list aria-labelledby="settings-reference-table-title">
      <li>
        <h4 className="mb-3 font-semibold">Agente de ejemplo</h4>
        <dl>
          {managementExampleDetails.map(({ label, value }) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div data-settings-item-action>
          <ManagementExampleAction />
        </div>
      </li>
    </ul>
  </section>
);

const PrivacyLayoutExample = (): JSX.Element => (
  <section className="settings-privacy" aria-label="Distribución de privacidad de ejemplo">
    <div className="settings-columns">
      <div className="settings-main">
        <p>El contacto conserva su propio espacio sin ocultar las explicaciones de privacidad.</p>
      </div>
      <aside className="settings-panel" aria-labelledby="settings-reference-contact-title">
        <section className="settings-section">
          <div className="settings-section-icon settings-contact-icon" aria-hidden="true">
            <HugeiconsIcon icon={Mail01Icon} size={32} />
          </div>
          <div className="settings-section-body flex flex-col gap-4">
            <h3 id="settings-reference-contact-title" className="settings-section-title">
              Solicitudes sobre tus datos
            </h3>
            <a className="settings-policy-link underline" href="https://fidyapp.com/politica">
              Política de tratamiento de datos
              <HugeiconsIcon icon={ArrowUpRight01Icon} size={18} aria-hidden="true" />
            </a>
          </div>
        </section>
      </aside>
    </div>
  </section>
);

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
          <ManagementExample />
        </div>
        <TokenExample />
      </div>
      <PrivacyLayoutExample />
    </div>
  </section>
);
