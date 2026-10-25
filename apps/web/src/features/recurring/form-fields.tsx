import { type JSX, type ReactNode, useState } from "react";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import { ChoiceField, CurrencyField, DefaultChoiceField, RecurringDateField } from "./fields";
import type { Category, PlanInput } from "./model";
import { frequencies, kinds } from "./model";

export const Field = ({
  label,
  name,
  children,
}: Readonly<{ label: string; name: string; children: ReactNode }>): JSX.Element => (
  <div data-recurring-slot="field" data-recurring-field={name} className="grid gap-2">
    <Label htmlFor={`recurring-${name}`}>{label}</Label>
    {children}
  </div>
);
export const ScheduleFields = ({
  initial,
  categories,
}: Readonly<{
  initial: Partial<PlanInput> & Pick<PlanInput, "timeZone">;
  categories: ReadonlyArray<Category>;
}>): JSX.Element => {
  const [frequency, setFrequency] = useState<string>(initial.frequency ?? "monthly");
  return (
    <>
      <Field label="Frecuencia" name="frequency">
        <ChoiceField
          name="frequency"
          label="Frecuencia"
          value={frequency}
          onChange={setFrequency}
          options={frequencies.map(([value, label]) => ({ value, label }))}
        />
      </Field>
      <div data-recurring-slot="date-fields" className="grid min-w-0 gap-3">
        <Field label="Primera fecha" name="firstDate">
          <RecurringDateField
            name="firstDate"
            label="Primera fecha"
            initial={initial.firstDate ?? ""}
            timeZone={initial.timeZone}
            required
          />
        </Field>
        <Field label="Fecha final (opcional)" name="endDate">
          <RecurringDateField
            name="endDate"
            label="Fecha final (opcional)"
            initial={initial.endDate ?? ""}
            timeZone={initial.timeZone}
            required={false}
          />
        </Field>
      </div>
      {frequency === "twice-monthly" ? <MonthDays initial={initial} /> : null}
      <ReferenceFields initial={initial} categories={categories} />
    </>
  );
};
export const IdentityFields = ({
  initial,
}: Readonly<{ initial: Partial<PlanInput> }>): JSX.Element => (
  <>
    <Field label="Nombre" name="name">
      <Input id="recurring-name" name="name" required maxLength={120} defaultValue={initial.name} />
    </Field>
    <Field label="Tipo" name="kind">
      <DefaultChoiceField
        name="kind"
        label="Tipo"
        initial={initial.kind ?? "expense"}
        options={kinds.map(([value, label]) => ({ value, label }))}
      />
    </Field>
    <Field label="Pago de tarjeta" name="cardPayment">
      <DefaultChoiceField
        name="cardPayment"
        label="Pago de tarjeta"
        initial={initial.cardPayment === true ? "yes" : "no"}
        options={[
          { value: "no", label: "No" },
          { value: "yes", label: "Sí (selecciona Transferencias)" },
        ]}
      />
    </Field>
    <Field label="Moneda" name="currency">
      <CurrencyField initial={initial.currency ?? "COP"} />
    </Field>
  </>
);

const ReferenceFields = ({
  initial,
  categories,
}: Readonly<{
  initial: Partial<PlanInput> & Pick<PlanInput, "timeZone">;
  categories: ReadonlyArray<Category>;
}>): JSX.Element => (
  <>
    <Field label="Contraparte (opcional)" name="counterparty">
      <Input
        id="recurring-counterparty"
        name="counterparty"
        defaultValue={initial.counterparty}
        maxLength={120}
      />
    </Field>
    <Field label="Categoría (opcional)" name="categoryId">
      <DefaultChoiceField
        name="categoryId"
        label="Categoría (opcional)"
        initial={initial.categoryId ?? ""}
        options={[
          { value: "", label: "Sin categoría" },
          ...categories.map((category) => ({ value: category.id, label: category.label })),
        ]}
      />
    </Field>
    <p className="text-xs text-muted-foreground">
      Cuenta: sin cuentas disponibles. Puedes planear sin seleccionar una cuenta.
    </p>
  </>
);

const MonthDays = ({ initial }: Readonly<{ initial: Partial<PlanInput> }>): JSX.Element => (
  <>
    <p className="text-xs text-muted-foreground">
      Para dos veces al mes, elige dos días. Los meses cortos usan su último día y conservan el día
      original.
    </p>
    <div data-recurring-slot="date-fields" className="grid min-w-0 gap-3">
      <Field label="Primer día del mes" name="day1">
        <Input
          id="recurring-day1"
          name="day1"
          placeholder="15"
          defaultValue={initial.monthDays?.[0] ?? "15"}
        />
      </Field>
      <Field label="Segundo día (o último)" name="day2">
        <Input
          id="recurring-day2"
          name="day2"
          placeholder="último"
          defaultValue={
            initial.monthDays?.[1] === "last" ? "último" : (initial.monthDays?.[1] ?? "último")
          }
        />
      </Field>
    </div>
  </>
);
