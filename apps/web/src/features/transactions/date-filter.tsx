import type { Option } from "effect";
import type { JSX } from "react";
import { CalendarField } from "@/ui/components/calendar-field";

export const TransactionDateFilter = (
  props: Readonly<{
    value: string;
    month: Option.Option<string>;
    timeZone: string;
    disabled: boolean;
    onChange: (value: string) => void;
  }>
): JSX.Element => (
  <CalendarField
    {...props}
    id="transaction-date-filter"
    label="Fecha"
    required={false}
    appearance="filter"
  />
);
