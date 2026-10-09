import { Option } from "effect";
import type { JSX, ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/ui/class-names";
import { Button } from "@/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/ui/components/dropdown-menu";

type DropdownProps = Readonly<{
  id: string;
  label: string;
  value: string;
  options: ReadonlyArray<Readonly<{ value: string; label: string }>>;
  disabled: boolean;
  width: "full" | "auto";
  leading: ReactNode;
  onChange: (value: string) => void;
  triggerLabel: Option.Option<string>;
}>;

/** Uses the same keyboard, dismissal, and selection pattern as ledger sorting. */
export const TransactionDropdown = ({
  id,
  label,
  value,
  options,
  disabled,
  width,
  leading,
  onChange,
  triggerLabel,
}: DropdownProps): JSX.Element => (
  <DropdownMenu>
    <DropdownMenuTrigger
      id={id}
      aria-label={label}
      render={
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          className={cn(width === "full" && "w-full")}
        />
      }
    >
      {leading}
      <span className={cn(width === "full" && "flex-1 text-left")}>
        {Option.getOrElse(
          triggerLabel,
          () => options.find((option) => option.value === value)?.label ?? ""
        )}
      </span>
      <HugeiconsIcon
        icon={ArrowDown01Icon}
        strokeWidth={1.5}
        data-icon="inline-end"
        aria-hidden="true"
      />
    </DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="min-w-56">
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
