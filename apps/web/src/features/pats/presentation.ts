import { DateTime } from "effect";

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  timeZone: "UTC",
});

/** Displays the UTC calendar date while retaining the full instant in time element metadata. */
export const formatPATDate = (value: DateTime.Utc): string =>
  dateFormatter.format(DateTime.toDate(value)).replaceAll("/", "-");
