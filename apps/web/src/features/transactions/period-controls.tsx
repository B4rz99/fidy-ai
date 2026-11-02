import { Schema } from "effect";
import type { JSX } from "react";
import { Button } from "@/ui/components/button";
import { Input } from "@/ui/components/input";
import { TransactionMonth, shiftTransactionMonth } from "./period";

export const TransactionPeriodControls = ({
  value,
  label,
  disabled,
  onChange,
}: Readonly<{
  value: string;
  label: string;
  disabled: boolean;
  onChange: (month: string) => void;
}>): JSX.Element => (
  <nav
    aria-label="Periodo de transacciones"
    className="flex flex-wrap items-center gap-2 px-4 py-2"
  >
    <Button
      variant="outline"
      aria-label="Mes anterior"
      disabled={disabled || value === "0002-01"}
      onClick={() => onChange(shiftTransactionMonth({ month: value, offset: -1 }))}
    >
      ‹
    </Button>
    <span className="text-sm capitalize">{label}</span>
    <Input
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
