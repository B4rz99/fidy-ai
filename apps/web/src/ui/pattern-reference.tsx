import { type JSX, type MouseEvent, useState } from "react";
import { Option } from "effect";
import { Cancel01Icon, PauseCircleIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Badge } from "@/ui/components/badge";
import { Button } from "@/ui/components/button";
import { CalendarField } from "@/ui/components/calendar-field";
import { Card, CardContent, CardHeader, CardTitle } from "@/ui/components/card";
import { ChoiceDropdown, InlineChoiceDropdown } from "@/ui/components/choice-dropdown";
import { SearchableChoiceDropdown } from "@/ui/components/searchable-choice-dropdown";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/ui/components/table";

const categories = [
  { value: "home", label: "Vivienda" },
  { value: "services", label: "Servicios" },
];
const currencies = [
  { value: "COP", label: "COP · Peso colombiano" },
  { value: "USD", label: "USD · Dólar estadounidense" },
  { value: "EUR", label: "EUR · Euro" },
];
const statuses = [
  { label: "Activo", variant: "success", icon: Tick02Icon },
  { label: "Pausado", variant: "warning", icon: PauseCircleIcon },
  { label: "Dejado de seguir", variant: "destructive", icon: Cancel01Icon },
] as const;

const ChoiceExamples = (): JSX.Element => {
  const [category, setCategory] = useState("home");
  const [currency, setCurrency] = useState("COP");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Desplegables</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p>Una lista corta usa selección simple. Una lista larga permite buscar.</p>
        <ChoiceDropdown
          id="pattern-category"
          label="Categoría del patrón"
          value={category}
          options={categories}
          disabled={false}
          width="full"
          leading={null}
          triggerLabel={Option.none()}
          onChange={setCategory}
        />
        <SearchableChoiceDropdown
          id="pattern-currency"
          label="Moneda del patrón"
          value={currency}
          options={currencies}
          disabled={false}
          width="full"
          onChange={setCurrency}
        />
        <ChoiceDropdown
          id="pattern-disabled"
          label="Selección deshabilitada"
          value="home"
          options={categories}
          disabled
          width="full"
          leading={null}
          triggerLabel={Option.none()}
          onChange={setCategory}
        />
      </CardContent>
    </Card>
  );
};

const CalendarExample = (): JSX.Element => {
  const [date, setDate] = useState("2026-10-15");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Fecha</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p>El mismo calendario en formularios y filtros; día, mes y año en español.</p>
        <CalendarField
          id="pattern-date"
          label="Fecha del patrón"
          value={date}
          timeZone="America/Bogota"
          disabled={false}
          required
          appearance="field"
          onChange={setDate}
        />
        <CalendarField
          id="pattern-date-disabled"
          label="Fecha deshabilitada"
          value={date}
          timeZone="America/Bogota"
          disabled
          required
          appearance="field"
          onChange={setDate}
        />
      </CardContent>
    </Card>
  );
};

const isRowClick = (event: MouseEvent<HTMLTableRowElement>): boolean =>
  event.target instanceof Element &&
  event.currentTarget.contains(event.target) &&
  event.target.closest("button, a, [role=menuitemradio]") === null;

const RowExample = (): JSX.Element => {
  const [category, setCategory] = useState("home");
  const [message, setMessage] = useState("Selecciona la fila para editar el ejemplo.");
  const edit = (): void => setMessage("Edición abierta: Arriendo de ejemplo.");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Filas</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p>La fila completa abre la edición. La categoría se cambia por separado.</p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Recurrente</TableHead>
              <TableHead>Categoría</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow
              interaction="clickable"
              tabIndex={0}
              aria-label="Editar Arriendo de ejemplo"
              onClick={(event) => {
                if (isRowClick(event)) {
                  edit();
                }
              }}
              onKeyDown={(event) => {
                if (event.target !== event.currentTarget || !["Enter", " "].includes(event.key)) {
                  return;
                }
                event.preventDefault();
                edit();
              }}
            >
              <TableCell>Arriendo de ejemplo</TableCell>
              <TableCell>
                <InlineChoiceDropdown
                  label="Categoría de Arriendo de ejemplo"
                  value={category}
                  options={categories}
                  leading={null}
                  disabled={false}
                  onChange={setCategory}
                >
                  {categories.find((item) => item.value === category)?.label}
                </InlineChoiceDropdown>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <output>{message}</output>
      </CardContent>
    </Card>
  );
};

const StatusExamples = (): JSX.Element => (
  <Card>
    <CardHeader>
      <CardTitle>Estados</CardTitle>
    </CardHeader>
    <CardContent className="grid gap-4">
      <p>El texto y el icono explican el estado, además del color.</p>
      <div className="flex flex-wrap gap-3">
        {statuses.map(({ label, variant, icon }) => (
          <Badge key={label} variant={variant}>
            <HugeiconsIcon icon={icon} aria-hidden="true" />
            {label}
          </Badge>
        ))}
      </div>
    </CardContent>
  </Card>
);

const FocusExamples = (): JSX.Element => {
  const [message, setMessage] = useState("Prueba con el ratón y luego con Tab, Enter y Escape.");
  return (
    <Card>
      <CardHeader>
        <CardTitle>Foco e interacción</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <p>El teclado mantiene una señal visible. El clic no deja un anillo verde persistente.</p>
        <div className="flex flex-wrap gap-3">
          <Button onClick={() => setMessage("Acción principal activada.")}>Acción principal</Button>
          <Button
            variant="outline"
            focusAppearance="subtle"
            onClick={() => setMessage("Acción secundaria activada.")}
          >
            Acción secundaria
          </Button>
          <Button
            variant="destructive"
            focusAppearance="subtle"
            onClick={() => setMessage("Desactivación de ejemplo. No se modificó ningún token.")}
          >
            Desactivar
          </Button>
          <Button variant="destructive" disabled>
            Desactivar todos los tokens
          </Button>
        </div>
        <output>{message}</output>
      </CardContent>
    </Card>
  );
};

export const PatternReference = (): JSX.Element => (
  <section id="patterns" aria-labelledby="patterns-heading" className="grid gap-6">
    <div className="grid gap-2">
      <h2 id="patterns-heading" className="text-2xl font-semibold">
        Patrones compartidos
      </h2>
      <p>Ejemplos interactivos locales. No consultan ni guardan datos de tu cuenta.</p>
    </div>
    <div className="grid gap-6 md:grid-cols-2">
      <ChoiceExamples />
      <CalendarExample />
      <StatusExamples />
      <FocusExamples />
    </div>
    <RowExample />
  </section>
);
