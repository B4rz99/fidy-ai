import { DateTime } from "effect";

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

export const formatPATDate = (value: DateTime.Utc): string =>
  dateFormatter.format(DateTime.toDate(value)).replaceAll(" de ", " ");

export const activePATReactivityKey = ["pats", "active"] as const;
