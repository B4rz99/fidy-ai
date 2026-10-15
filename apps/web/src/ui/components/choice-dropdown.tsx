import { Option } from "effect";
import type { JSX, ReactNode } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { cn } from "@/ui/class-names";
import { Button } from "./button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./dropdown-menu";

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

export const ChoiceDropdown = ({
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
          contentLayout="wrap"
          type="button"
          variant="outline"
          focusAppearance="subtle"
          disabled={disabled}
          className={cn(width === "full" && "w-full")}
        />
      }
    >
      {leading}
      <span
        className={cn(
          "min-w-0 whitespace-normal [overflow-wrap:anywhere]",
          width === "full" && "flex-1 text-left"
        )}
      >
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
    <ChoiceMenuOptions value={value} options={options} onChange={onChange} />
  </DropdownMenu>
);

export const ChoiceMenuOptions = ({
  value,
  options,
  onChange,
}: Pick<DropdownProps, "value" | "options" | "onChange">): JSX.Element => (
  <DropdownMenuContent align="start" className="min-w-0 max-w-(--available-width)">
    <DropdownMenuRadioGroup
      value={value}
      onValueChange={(next: unknown) => {
        if (typeof next === "string") onChange(next);
      }}
    >
      {options.map((option) => (
        <DropdownMenuRadioItem key={option.value} value={option.value} closeOnClick>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{option.label}</span>
        </DropdownMenuRadioItem>
      ))}
    </DropdownMenuRadioGroup>
  </DropdownMenuContent>
);

/** Selection effects belong to the caller. */
export const InlineChoiceDropdown = ({
  label,
  disabled,
  leading,
  children,
  value,
  options,
  onChange,
}: Pick<DropdownProps, "label" | "disabled" | "leading" | "value" | "options" | "onChange"> &
  Readonly<{ children: ReactNode }>): JSX.Element => (
  <DropdownMenu>
    <DropdownMenuTrigger
      aria-label={label}
      disabled={disabled}
      render={
        <button
          type="button"
          aria-label={label}
          className="flex min-h-11 w-full items-center gap-2 rounded-md py-1 text-left outline-none transition-colors enabled:cursor-pointer enabled:hover:bg-muted focus-visible:bg-muted focus-visible:underline focus-visible:underline-offset-4 aria-expanded:bg-muted"
        />
      }
    >
      {leading}
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</span>
    </DropdownMenuTrigger>
    <ChoiceMenuOptions value={value} options={options} onChange={onChange} />
  </DropdownMenu>
);
