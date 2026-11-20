import { Combobox } from "@base-ui/react/combobox";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type { JSX } from "react";
import { cn } from "@/ui/class-names";
import { Button } from "./button";
import { Input } from "./input";
import { SearchableChoiceLabel } from "./searchable-choice-label";

type Choice = Readonly<{ value: string; label: string }>;
type Props = Readonly<{
  id: string;
  label: string;
  value: string;
  options: ReadonlyArray<Choice>;
  disabled: boolean;
  width: "full" | "auto";
  onChange: (value: string) => void;
}>;
const ChoiceDropdown = ({
  id,
  label,
  value,
  options,
  disabled,
  width,
  onChange,
  defaultOpen,
}: Props & Readonly<{ defaultOpen: boolean }>): JSX.Element => (
  <Combobox.Root
    defaultOpen={defaultOpen}
    items={options}
    value={options.find((item) => item.value === value) ?? null}
    itemToStringLabel={(item) => item.label}
    itemToStringValue={(item) => item.value}
    disabled={disabled}
    onValueChange={(item) => {
      if (item !== null) onChange(item.value);
    }}
  >
    <Combobox.Trigger
      id={id}
      aria-label={label}
      render={
        <Button
          type="button"
          contentLayout="wrap"
          variant="outline"
          focusAppearance="subtle"
          disabled={disabled}
          className={cn(width === "full" && "w-full")}
        />
      }
    >
      <SearchableChoiceLabel
        label={options.find((item) => item.value === value)?.label ?? "Seleccionar"}
        width={width}
      />
    </Combobox.Trigger>
    <SearchableChoicePopup label={label} />
  </Combobox.Root>
);
export const SearchableChoiceDropdown = (props: Props): JSX.Element => (
  <ChoiceDropdown {...props} defaultOpen={false} />
);
export const OpenSearchableChoiceDropdown = (props: Props): JSX.Element => (
  <ChoiceDropdown {...props} defaultOpen />
);
const SearchableChoicePopup = ({ label }: Readonly<{ label: string }>): JSX.Element => (
  <Combobox.Portal>
    <Combobox.Positioner
      sideOffset={6}
      align="start"
      collisionAvoidance={{ side: "shift", align: "shift" }}
      className="z-50"
    >
      <Combobox.Popup className="flex max-h-(--available-height) flex-col w-(--anchor-width) min-w-[min(14rem,var(--available-width))] max-w-(--available-width) overflow-hidden rounded-lg border bg-popover p-1 text-popover-foreground shadow-md">
        <Combobox.Input
          aria-label={`Buscar: ${label}`}
          placeholder="Buscar…"
          render={<Input className="shrink-0" />}
        />
        <Combobox.Empty className="p-4 text-center text-sm text-muted-foreground empty:p-0">
          Sin resultados.
        </Combobox.Empty>
        <Combobox.List className="min-h-0 max-h-64 overflow-y-auto overscroll-contain p-1">
          {(item: Choice) => (
            <Combobox.Item
              key={item.value}
              value={item}
              className="relative flex min-h-11 cursor-default items-center gap-2 rounded-md py-2 pr-8 pl-2 text-sm outline-none data-highlighted:bg-control-hover data-highlighted:text-foreground data-highlighted:underline data-highlighted:underline-offset-4"
            >
              {item.label}
              <Combobox.ItemIndicator className="absolute right-2">
                <HugeiconsIcon icon={Tick02Icon} size={16} strokeWidth={1.5} />
              </Combobox.ItemIndicator>
            </Combobox.Item>
          )}
        </Combobox.List>
      </Combobox.Popup>
    </Combobox.Positioner>
  </Combobox.Portal>
);
