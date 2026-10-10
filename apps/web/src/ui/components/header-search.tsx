import type { JSX } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Search01Icon } from "@hugeicons/core-free-icons";
import { Input } from "./input";
import { Button } from "./button";

const focusSearch: React.RefCallback<HTMLInputElement> = (element): void => {
  element?.focus();
};
/** Opens a focused search field in place; Escape closes it without clearing the feature-owned query. */
export const HeaderSearch = ({
  value,
  onChange,
  open,
  onOpenChange,
  disabled,
  label,
}: Readonly<{
  value: string;
  onChange: (value: string) => void;
  open: boolean;
  onOpenChange: (value: boolean) => void;
  disabled: boolean;
  label: string;
}>): JSX.Element => (
  <>
    {" "}
    {open ? (
      <Input
        ref={focusSearch}
        aria-label={label}
        placeholder={label}
        value={value}
        disabled={disabled}
        className="min-w-0 sm:w-52"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") onOpenChange(false);
        }}
      />
    ) : (
      <Button variant="outline" disabled={disabled} onClick={() => onOpenChange(true)}>
        <HugeiconsIcon
          icon={Search01Icon}
          strokeWidth={1.5}
          data-icon="inline-start"
          aria-hidden="true"
        />
        Buscar
      </Button>
    )}
  </>
);
