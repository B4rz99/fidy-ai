import { DateTime, Option } from "effect";
import type { JSX } from "react";
import { es } from "react-day-picker/locale";
import { Calendar } from "./calendar";
import type { DateFieldProps } from "./calendar-field";

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
const filterMonth = (props: DateFieldProps): Option.Option<Date> =>
  props.appearance === "filter"
    ? Option.flatMap(props.month, (value) => localDate(`${value}-01`, props.timeZone))
    : Option.none();

export const CalendarDates = ({
  field,
  dismiss,
}: Readonly<{ field: DateFieldProps; dismiss: () => void }>): JSX.Element => {
  const selected = Option.getOrUndefined(localDate(field.value, field.timeZone));
  return (
    <Calendar
      mode="single"
      locale={es}
      timeZone={field.timeZone}
      selected={selected}
      defaultMonth={selected ?? Option.getOrUndefined(filterMonth(field))}
      onSelect={(date) => {
        if (date === undefined && field.required) return;
        field.onChange(selectedDate(Option.fromNullishOr(date), field.timeZone));
        dismiss();
      }}
    />
  );
};
