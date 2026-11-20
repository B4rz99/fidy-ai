import { Suspense, lazy, useState } from "react";
import type { JSX } from "react";
import { DateTime, type Option } from "effect";

import { HugeiconsIcon } from "@hugeicons/react";
import { Calendar03Icon } from "@hugeicons/core-free-icons";
import { Button } from "./button";
import { PendingRead } from "./pending-read";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "./popover";
import { cn } from "@/ui/class-names";
import { makeCompactDateFormatter } from "@/ui/compact-date";

export type DateFieldProps = Readonly<{
  id: string;
  label: string;
  value: string;
  timeZone: string;
  disabled: boolean;
  required: boolean;
  onChange: (value: string) => void;
}> &
  (
    | Readonly<{ appearance: "filter"; month: Option.Option<string> }>
    | Readonly<{ appearance: "field" | "review" }>
  );
const CalendarDates = lazy(() =>
  import("./calendar-dates").then(({ CalendarDates }) => ({ default: CalendarDates }))
);
const dateLabel = (value: string): string =>
  value === "" ? "Selecciona una fecha" : value.split("-").toReversed().join("-");

const compactDateLabel = makeCompactDateFormatter("es-CO");
const accessibleDateFormat = new Intl.DateTimeFormat("es-CO", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

const calendarLabel = ({
  appearance,
  value,
}: Pick<DateFieldProps, "appearance" | "value">): string => {
  if (appearance === "filter") return value === "" ? "Fecha" : `Fecha: ${compactDateLabel(value)}`;
  if (appearance === "review" && value !== "") {
    return compactDateLabel(value);
  }
  return dateLabel(value);
};

const calendarAccessibleLabel = (props: DateFieldProps): string => {
  if (props.appearance === "filter" && props.value === "") return props.label;
  if ((props.appearance !== "review" && props.appearance !== "filter") || props.value === "") {
    return `${props.label}: ${calendarLabel(props)}`;
  }
  const date = accessibleDateFormat.format(
    DateTime.toEpochMillis(DateTime.makeUnsafe(`${props.value}T12:00:00Z`))
  );
  return `${props.label}: ${date}`;
};

export const CalendarField = (props: DateFieldProps): JSX.Element => {
  const [open, setOpen] = useState(false);
  const visibleLabel = calendarLabel(props);
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
        {open ? (
          <Suspense fallback={<PendingRead label="Cargando calendario" />}>
            <CalendarDates field={props} dismiss={() => setOpen(false)} />
          </Suspense>
        ) : null}
        {!props.required ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              props.onChange("");
              setOpen(false);
            }}
          >
            {props.appearance === "filter" ? "Quitar filtro de día" : "Sin cambiar fecha"}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
};
