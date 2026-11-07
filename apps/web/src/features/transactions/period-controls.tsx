import { Schema } from "effect";
import { type ComponentProps, type JSX, useId } from "react";
import { cn } from "@/ui/class-names";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { TransactionMonth, shiftTransactionMonth } from "./period";

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
}: PeriodControlsProps): JSX.Element => {
  const monthId = useId();
  return (
    <nav
      aria-label="Periodo de transacciones"
      className={cn("flex flex-wrap items-center gap-2 px-4 py-2", className)}
    >
      <Button
        variant="outline"
        aria-label="Mes anterior"
        disabled={disabled || value === "0002-01"}
        onClick={() => onChange(shiftTransactionMonth({ month: value, offset: -1 }))}
      >
        ‹
      </Button>
      <span className="block flex-1 text-sm first-letter:uppercase sm:flex-none">{label}</span>
      <Button
        variant="outline"
        aria-label="Mes siguiente"
        disabled={disabled || value === "9998-12"}
        onClick={() => onChange(shiftTransactionMonth({ month: value, offset: 1 }))}
      >
        ›
      </Button>
      <label
        htmlFor={monthId}
        className="flex w-full flex-wrap items-center justify-between gap-2 text-sm sm:w-auto"
      >
        Mes de transacciones
        <Input
          id={monthId}
          type="month"
          aria-label="Mes de transacciones"
          value={value}
          min="0002-01"
          max="9998-12"
          className="w-auto"
          disabled={disabled}
          onChange={(event) => {
            const month = event.target.value;
            if (Schema.is(TransactionMonth)(month)) onChange(month);
          }}
        />
      </label>
    </nav>
  );
};
