import { Clock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Option } from "effect";
import { type JSX, useState } from "react";
import { Button } from "./button";
import { ChoiceDropdown } from "./choice-dropdown";
import { Label } from "./label";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
  PopoverTrigger,
} from "./popover";

type Props = Readonly<{
  id: string;
  label: string;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}>;
const hoursPerDay = 24;
const minutesPerHour = 60;
const clockOptions = (length: number): ReadonlyArray<Readonly<{ value: string; label: string }>> =>
  Array.from({ length }, (_, index) => {
    const value = String(index).padStart(2, "0");
    return { value, label: value };
  });
const hours = clockOptions(hoursPerDay);
const minutes = clockOptions(minutesPerHour);

export const TimeField = (props: Props): JSX.Element => {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id={props.id}
        aria-label={props.label}
        render={
          <Button
            type="button"
            variant="outline"
            focusAppearance="subtle"
            disabled={props.disabled}
            className="w-full"
          />
        }
      >
        <HugeiconsIcon icon={Clock01Icon} data-icon="inline-start" aria-hidden="true" />
        <span className="tabular-nums">{props.value || "Elegir hora"}</span>
      </PopoverTrigger>
      <PopoverContent align="end">
        <PopoverTitle>{props.label}</PopoverTitle>
        <PopoverDescription>Formato de 24 horas</PopoverDescription>
        <TimeChoices {...props} />
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Listo
        </Button>
      </PopoverContent>
    </Popover>
  );
};
const TimeChoices = ({ id, value, disabled, onChange }: Props): JSX.Element => {
  const [hour = "00", minute = "00"] = value.split(":");
  return (
    <div className="grid grid-cols-2 gap-3 py-2">
      <div className="grid gap-2">
        <Label htmlFor={`${id}-hours`}>Hora</Label>
        <ChoiceDropdown
          id={`${id}-hours`}
          label="Horas"
          value={hour}
          options={hours}
          disabled={disabled}
          width="full"
          leading={null}
          triggerLabel={Option.none()}
          onChange={(next) => onChange(`${next}:${minute}`)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor={`${id}-minutes`}>Minutos</Label>
        <ChoiceDropdown
          id={`${id}-minutes`}
          label="Minutos"
          value={minute}
          options={minutes}
          disabled={disabled}
          width="full"
          leading={null}
          triggerLabel={Option.none()}
          onChange={(next) => onChange(`${hour}:${next}`)}
        />
      </div>
    </div>
  );
};
