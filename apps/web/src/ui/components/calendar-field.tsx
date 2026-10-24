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
  appearance: "field" | "filter" | "review";
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

const compactDateLabel = (value: string): string =>
  new Intl.DateTimeFormat("es-CO", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  })
    .formatToParts(new Date(`${value}T12:00:00Z`))
    .filter((part) => ["day", "month", "year"].includes(part.type))
    .map((part) => part.value.replace(/\.$/u, ""))
    .join(" ");

const calendarLabel = ({
  appearance,
  value,
}: Pick<DateFieldProps, "appearance" | "value">): string => {
  if (appearance === "filter") return "Fecha";
  if (appearance === "review" && value !== "") {
    return compactDateLabel(value);
  }
  return dateLabel(value);
};

const calendarAccessibleLabel = (props: DateFieldProps): string => {
  if (props.appearance === "filter") return props.label;
  if (props.appearance !== "review" || props.value === "") {
    return `${props.label}: ${calendarLabel(props)}`;
  }
  const date = new Intl.DateTimeFormat("es-CO", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${props.value}T12:00:00Z`));
  return `${props.label}: ${date}`;
};

export const CalendarField = (props: DateFieldProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const visibleLabel = calendarLabel(props);
  const selected = Option.getOrUndefined(localDate(props.value, props.timeZone));
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id={props.id}
        aria-label={calendarAccessibleLabel(props)}
        render={
          <Button
            contentLayout="wrap"
            type="button"
            variant="outline"
            focusAppearance="subtle"
            disabled={props.disabled}
            className={cn(props.appearance !== "filter" && "w-full")}
          />
        }
      >
        <HugeiconsIcon
          icon={Calendar03Icon}
          strokeWidth={1.5}
          data-icon="inline-start"
          aria-hidden="true"
        />
        {visibleLabel}
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
