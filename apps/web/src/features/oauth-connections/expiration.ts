import { DateTime } from "effect";
import { makeCompactDateFormatter } from "@/ui/compact-date";

const compactDateFormatter = makeCompactDateFormatter("es-CO");
const timeFormatter = new Intl.DateTimeFormat("es-CO", {
  timeStyle: "short",
  timeZone: "America/Bogota",
});

export const formatExpiration = (value: DateTime.Utc): string => {
  const localDate = DateTime.formatIsoDate(DateTime.setZoneNamedUnsafe(value, "America/Bogota"));
  return `${compactDateFormatter(localDate)} · ${timeFormatter.format(DateTime.toDate(value))}`;
};
