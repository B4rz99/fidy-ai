import type { JSX } from "react";
import { CalendarField } from "@/ui/components/calendar-field";

/** Opens the shared calendar directly from the ledger header. */
export const TransactionDateFilter = (
  props: Readonly<{
    value: string;
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
