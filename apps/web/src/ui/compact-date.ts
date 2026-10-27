import { DateTime } from "effect";

/** Compact calendar-day labels retain localized components and never reinterpret the input day. */
export const makeCompactDateFormatter = (locale: string): ((localDate: string) => string) => {
  const formatter = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
  return (localDate) =>
    formatter
      .formatToParts(DateTime.toEpochMillis(DateTime.makeUnsafe(`${localDate}T12:00:00Z`)))
      .flatMap((part) =>
        ["day", "month", "year"].includes(part.type) ? [part.value.replace(/\.$/u, "")] : []
      )
      .join(" ");
};
