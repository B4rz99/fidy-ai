import { type JSX, type ReactNode, useState } from "react";
import { Input } from "@/ui/components/input";
import { Label } from "@/ui/components/label";
import { NativeSelect } from "@/ui/components/native-select";
import type { Category, PlanInput } from "./model";
import { frequencies, kinds } from "./model";

export const Field = ({
  label,
  name,
  children,
}: Readonly<{ label: string; name: string; children: ReactNode }>): JSX.Element => (
  <div className="grid gap-2">
    <Label htmlFor={`recurring-${name}`}>{label}</Label>
    {children}
  </div>
);
export const ScheduleFields = ({
  initial,
  categories,
}: Readonly<{ initial: Partial<PlanInput>; categories: ReadonlyArray<Category> }>): JSX.Element => {
  const [frequency, setFrequency] = useState<string>(initial.frequency ?? "monthly");
  return (
    <>
      <Field label="Frecuencia" name="frequency">
        <NativeSelect
          id="recurring-frequency"
          name="frequency"
          size="default"
          value={frequency}
          onChange={(event) => setFrequency(event.target.value)}
        >
          {frequencies.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </NativeSelect>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Primera fecha" name="firstDate">
          <Input
            id="recurring-firstDate"
            name="firstDate"
            type="date"
            required
            defaultValue={initial.firstDate}
          />
        </Field>
        <Field label="Fecha final (opcional)" name="endDate">
          <Input id="recurring-endDate" name="endDate" type="date" defaultValue={initial.endDate} />
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
      <NativeSelect
        id="recurring-kind"
        name="kind"
        size="default"
        defaultValue={initial.kind ?? "expense"}
      >
        {kinds.map(([value, label]) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </NativeSelect>
    </Field>
    <Field label="Pago de tarjeta" name="cardPayment">
      <NativeSelect
        id="recurring-cardPayment"
        name="cardPayment"
        size="default"
        defaultValue={initial.cardPayment === true ? "yes" : "no"}
      >
        <option value="no">No</option>
        <option value="yes">Sí (selecciona Transferencias)</option>
      </NativeSelect>
    </Field>
    <Field label="Moneda" name="currency">
      <Input
        id="recurring-currency"
        name="currency"
        required
        defaultValue={initial.currency ?? "COP"}
        maxLength={3}
      />
    </Field>
  </>
);

const ReferenceFields = ({
  initial,
  categories,
}: Readonly<{ initial: Partial<PlanInput>; categories: ReadonlyArray<Category> }>): JSX.Element => (
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
      <NativeSelect
        id="recurring-categoryId"
        name="categoryId"
        size="default"
        defaultValue={initial.categoryId ?? ""}
      >
        <option value="">Sin categoría</option>
        {categories.map((category) => (
          <option key={category.id} value={category.id}>
            {category.label}
          </option>
        ))}
      </NativeSelect>
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
    <div className="grid grid-cols-2 gap-3">
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
