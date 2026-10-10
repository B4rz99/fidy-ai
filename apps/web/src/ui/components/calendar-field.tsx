import { useState } from "react";
import type { JSX } from "react";
import { DateTime, Option } from "effect";
import { es } from "react-day-picker/locale";
import { HugeiconsIcon } from "@hugeicons/react";
import { Calendar03Icon } from "@hugeicons/core-free-icons";
import { Button } from "./button";
import { Calendar } from "./calendar";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "./popover";
import { cn } from "@/ui/class-names";

type DateFieldProps = Readonly<{
  id: string;
  label: string;
  value: string;
  timeZone: string;
  disabled: boolean;
  required: boolean;
  appearance: "field" | "filter";
  onChange: (value: string) => void;
}>;
const localDate = (value: string, timeZone: string): Option.Option<Date> =>
  DateTime.makeZoned(`${value}T00:00:00.000Z`, { timeZone, adjustForTimeZone: true }).pipe(
    Option.map(DateTime.toDateUtc)
  );
const selectedDate = (date: Option.Option<Date>, timeZone: string): string =>
  Option.isNone(date)
    ? ""
    : DateTime.formatIsoDate(
        DateTime.setZone(DateTime.makeUnsafe(date.value), DateTime.zoneMakeNamedUnsafe(timeZone))
      );
const dateLabel = (value: string): string =>
  value === "" ? "Selecciona una fecha" : value.split("-").toReversed().join("-");

/** Shares one Spanish calendar and User-zone conversion across filters and forms. */
export const CalendarField = (props: DateFieldProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const selected = Option.getOrUndefined(localDate(props.value, props.timeZone));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id={props.id}
        aria-label={props.label}
        render={
          <Button
            type="button"
            variant="outline"
            disabled={props.disabled}
            className={cn(props.appearance === "field" && "w-full")}
          />
        }
      >
        <HugeiconsIcon
          icon={Calendar03Icon}
          strokeWidth={1.5}
          data-icon="inline-start"
          aria-hidden="true"
        />
        {props.appearance === "filter" ? "Fecha" : dateLabel(props.value)}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto max-w-[calc(100vw-8px)] p-0">
        <PopoverTitle className="sr-only">
          {props.appearance === "filter" ? "Filtrar por fecha" : "Seleccionar fecha"}
        </PopoverTitle>
        <Calendar
          mode="single"
          locale={es}
          timeZone={props.timeZone}
          selected={selected}
          defaultMonth={selected}
          onSelect={(date) => {
            if (date === undefined && props.required) return;
            props.onChange(selectedDate(Option.fromNullishOr(date), props.timeZone));
            setOpen(false);
          }}
        />
        {!props.required ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              props.onChange("");
              setOpen(false);
            }}
          >
            {props.appearance === "filter" ? "Todas las fechas" : "Sin cambiar fecha"}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
};
