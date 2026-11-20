import { DateTime, Schema } from "effect";
import { type ComponentProps, type JSX, Suspense, lazy, useId, useState } from "react";
import { cn } from "@/ui/class-names";
import { Button } from "@/ui/components/button";
import { SearchableChoiceLabel } from "@/ui/components/searchable-choice-label";
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
const TransactionYearChoices = lazy(() =>
  import("./year-choices").then(({ TransactionYearChoices }) => ({
    default: TransactionYearChoices,
  }))
);

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
        <YearChoice
          id={`${id}-year`}
          value={year}
          disabled={disabled}
          onChange={(next) => changePeriod(`${next}-${month}`)}
        />
      </div>
    </>
  );
};

type YearChoiceProps = Readonly<{
  id: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}>;

const YearChoice = (props: YearChoiceProps): JSX.Element => {
  const [opened, setOpened] = useState(false);
  const trigger = (
    <Button
      id={props.id}
      type="button"
      aria-label="Año de transacciones"
      aria-haspopup="listbox"
      aria-expanded={false}
      aria-busy={opened}
      contentLayout="wrap"
      variant="outline"
      focusAppearance="subtle"
      className="w-full"
      disabled={props.disabled}
      onClick={() => setOpened(true)}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          setOpened(true);
        }
      }}
    >
      <SearchableChoiceLabel label={props.value} width="full" />
    </Button>
  );
  return opened ? (
    <Suspense fallback={trigger}>
      <TransactionYearChoices {...props} />
    </Suspense>
  ) : (
    trigger
  );
};
