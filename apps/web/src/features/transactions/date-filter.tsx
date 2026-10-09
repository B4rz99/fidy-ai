import { useState } from "react";
import type { JSX } from "react";
import { DateTime, Option } from "effect";
import { es } from "react-day-picker/locale";
import { HugeiconsIcon } from "@hugeicons/react";
import { Calendar03Icon } from "@hugeicons/core-free-icons";
import { Button } from "@/ui/components/button";
import { Calendar } from "@/ui/components/calendar";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "@/ui/components/popover";

const calendarDate = (date: Option.Option<Date>, timeZone: string): string =>
  Option.isNone(date)
    ? ""
    : DateTime.formatIsoDate(
        DateTime.setZone(DateTime.makeUnsafe(date.value), DateTime.zoneMakeNamedUnsafe(timeZone))
      );

/** Opens the calendar directly and filters by the selected local day, preserving the User's zone. */
export const TransactionDateFilter = ({
  value,
  timeZone,
  disabled,
  onChange,
}: Readonly<{
  value: string;
  timeZone: string;
  disabled: boolean;
  onChange: (value: string) => void;
}>): JSX.Element => {
  const [open, setOpen] = useState(false);
  const selected = DateTime.makeZoned(`${value}T00:00:00.000Z`, {
    timeZone,
    adjustForTimeZone: true,
  }).pipe(Option.map(DateTime.toDateUtc), Option.getOrUndefined);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button variant="outline" disabled={disabled} />}>
        <HugeiconsIcon
          icon={Calendar03Icon}
          strokeWidth={1.5}
          data-icon="inline-start"
          aria-hidden="true"
        />
        Fecha
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto max-w-[calc(100vw-40px)]">
        <PopoverTitle>Filtrar por fecha</PopoverTitle>
        <Calendar
          mode="single"
          locale={es}
          timeZone={timeZone}
          selected={selected}
          defaultMonth={selected}
          onSelect={(date) => {
            onChange(calendarDate(Option.fromNullishOr(date), timeZone));
            setOpen(false);
          }}
        />
        <Button
          variant="ghost"
          onClick={() => {
            onChange("");
            setOpen(false);
          }}
        >
          Todas las fechas
        </Button>
      </PopoverContent>
    </Popover>
  );
};
