import { DateTime, Schema } from "effect";
import { type ComponentProps, type JSX, useId } from "react";
import { cn } from "@/ui/class-names";
import { Button } from "@/ui/components/button";
import { SearchableChoiceDropdown } from "@/ui/components/searchable-choice-dropdown";
import { Label } from "@/ui/components/label";
import { NativeSelect, NativeSelectOption } from "@/ui/components/native-select";
import { TransactionMonth, shiftTransactionMonth } from "./period";

const monthOffset = "YYYY-".length;
const monthFormatter = new Intl.DateTimeFormat("es-CO", { month: "long", timeZone: "UTC" });
const months = Array.from({ length: 12 }, (_, index) => {
  const value = String(index + 1).padStart(2, "0");
  return {
    value,
    label: monthFormatter.format(
      DateTime.makeUnsafe(`2026-${value}-01T12:00:00Z`).epochMilliseconds
    ),
  };
});
const years = Array.from({ length: 9997 }, (_, index) => {
  const year = String(index + 2).padStart(4, "0");
  return { value: year, label: year };
});

type PeriodControlsProps = Readonly<{
  value: string;
  label: string;
  disabled: boolean;
  onChange: (month: string) => void;
}> &
  Pick<ComponentProps<"nav">, "className">;

export const TransactionPeriodControls = ({
  value,
  label,
  disabled,
  onChange,
  className,
}: PeriodControlsProps): JSX.Element => (
  <nav
    aria-label="Periodo de transacciones"
    data-transaction-slot="transaction-period"
    className={cn("p-4", className)}
  >
    <span className="text-sm first-letter:uppercase">{label}</span>
    <Button
      variant="outline"
      aria-label="Mes anterior"
      disabled={disabled || value === "0002-01"}
      onClick={() => onChange(shiftTransactionMonth({ month: value, offset: -1 }))}
    >
      ‹
    </Button>
    <PeriodChoices value={value} disabled={disabled} onChange={onChange} />
    <Button
      variant="outline"
      aria-label="Mes siguiente"
      disabled={disabled || value === "9998-12"}
      onClick={() => onChange(shiftTransactionMonth({ month: value, offset: 1 }))}
    >
      ›
    </Button>
  </nav>
);

const PeriodChoices = ({
  value,
  disabled,
  onChange,
}: Readonly<{
  value: string;
  disabled: boolean;
  onChange: (month: string) => void;
}>): JSX.Element => {
  const id = useId();
  const year = value.slice(0, 4);
  const month = value.slice(monthOffset);
  const changePeriod = (next: string): void => {
    if (Schema.is(TransactionMonth)(next)) onChange(next);
  };
  return (
    <>
      <div data-period-field="month">
        <Label htmlFor={`${id}-month`}>Mes</Label>
        <NativeSelect
          id={`${id}-month`}
          size="default"
          aria-label="Mes de transacciones"
          value={month}
          disabled={disabled}
          onChange={(event) => changePeriod(`${year}-${event.target.value}`)}
        >
          {months.map((option) => (
            <NativeSelectOption key={option.value} value={option.value}>
              {option.label}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </div>
      <div data-period-field="year">
        <Label htmlFor={`${id}-year`}>Año</Label>
        <SearchableChoiceDropdown
          rendering="fixed-rows"
          id={`${id}-year`}
          label="Año de transacciones"
          value={year}
          options={years}
          disabled={disabled}
          width="full"
          onChange={(next) => changePeriod(`${next}-${month}`)}
        />
      </div>
    </>
  );
};
