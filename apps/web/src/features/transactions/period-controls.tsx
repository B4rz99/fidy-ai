import { DateTime } from "effect";
import { type ComponentProps, type JSX } from "react";
import { cn } from "@/ui/class-names";
import { MonthPicker } from "@/features/recurring/month-picker";

const localToday = (): string => {
  const parts = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(DateTime.nowUnsafe().epochMilliseconds);

  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${get("year")}-${get("month")}-${get("day")}`;
};

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
    className={cn(className)}
  >
    <MonthPicker
      month={value}
      today={localToday()}
      select={onChange}
      label={label}
      disabled={disabled}
      variant="outline"
    />
  </nav>
);
