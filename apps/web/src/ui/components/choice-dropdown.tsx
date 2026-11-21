import { Option, Predicate } from "effect";
import type { AriaAttributes, JSX, ReactNode } from "react";
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
}> &
  Pick<AriaAttributes, "aria-invalid" | "aria-describedby">;

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
  ...aria
}: DropdownProps): JSX.Element => {
  const selectedLabel = Option.getOrElse(
    triggerLabel,
    () => options.find((option) => option.value === value)?.label ?? ""
  );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        id={id}
        aria-label={`${label}: ${selectedLabel}`}
        {...aria}
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
          {selectedLabel}
        </span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          strokeWidth={1.5}
          data-icon="inline-end"
          aria-hidden="true"
        />
      </DropdownMenuTrigger>
      <ChoiceMenu value={value} getOptions={() => options} onChange={onChange} />
    </DropdownMenu>
  );
};

type ChoiceMenuProps = Pick<DropdownProps, "value" | "onChange"> &
  Readonly<{ getOptions: () => DropdownProps["options"] }>;

const ChoiceMenu = (props: ChoiceMenuProps): JSX.Element => (
  <DropdownMenuContent align="start" className="min-w-0 max-w-(--available-width)">
    <ChoiceMenuOptions {...props} />
  </DropdownMenuContent>
);

const ChoiceMenuOptions = ({ value, getOptions, onChange }: ChoiceMenuProps): JSX.Element => (
  <DropdownMenuRadioGroup
    value={value}
    onValueChange={(next: unknown) => {
      if (Predicate.isString(next)) onChange(next);
    }}
  >
    {getOptions().map((option) => (
      <DropdownMenuRadioItem key={option.value} value={option.value} closeOnClick>
        <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{option.label}</span>
      </DropdownMenuRadioItem>
    ))}
  </DropdownMenuRadioGroup>
);

export const InlineChoiceDropdown = ({
  label,
  disabled,
  leading,
  children,
  value,
  getOptions,
  onChange,
}: ChoiceMenuProps &
  Pick<DropdownProps, "label" | "disabled" | "leading"> &
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
    <ChoiceMenu value={value} getOptions={getOptions} onChange={onChange} />
  </DropdownMenu>
);
