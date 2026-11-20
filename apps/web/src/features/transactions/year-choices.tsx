import { OpenSearchableChoiceDropdown } from "@/ui/components/searchable-choice-dropdown";
import type { JSX } from "react";

const years = Array.from({ length: 9997 }, (_, index) => {
  const year = String(index + 2).padStart(4, "0");
  return { value: year, label: year };
});

export const TransactionYearChoices = (
  props: Readonly<{
    id: string;
    value: string;
    disabled: boolean;
    onChange: (value: string) => void;
  }>
): JSX.Element => {
  return (
    <OpenSearchableChoiceDropdown
      {...props}
      label="Año de transacciones"
      options={years}
      width="full"
    />
  );
};
