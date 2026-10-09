import type { JSX } from "react";
import { Button } from "@/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/ui/components/dropdown-menu";

/** Uses the same keyboard, dismissal, and selection pattern as ledger sorting. */
export const TransactionFilterDropdown = ({
  id,
  label,
  value,
  options,
  disabled,
  onChange,
}: Readonly<{
  id: string;
  label: string;
  value: string;
  options: ReadonlyArray<Readonly<{ value: string; label: string }>>;
  disabled: boolean;
  onChange: (value: string) => void;
}>): JSX.Element => (
  <DropdownMenu>
    <DropdownMenuTrigger
      id={id}
      aria-label={label}
      render={<Button variant="outline" disabled={disabled} />}
    >
      {options.find((option) => option.value === value)?.label}
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start">
      <DropdownMenuRadioGroup
        value={value}
        onValueChange={(next: unknown) => {
          if (typeof next === "string") onChange(next);
        }}
      >
        {options.map((option) => (
          <DropdownMenuRadioItem key={option.value} value={option.value} closeOnClick>
            {option.label}
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
    </DropdownMenuContent>
  </DropdownMenu>
);
