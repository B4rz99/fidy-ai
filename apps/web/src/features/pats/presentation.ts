import { DateTime } from "effect";

const dateFormatter = new Intl.DateTimeFormat("es-CO", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "UTC",
});

/** Displays the UTC date and preserves the complete instant in element metadata. */
export const formatPATDate = (value: DateTime.Utc): string =>
  dateFormatter.format(DateTime.toDate(value)).replaceAll(" de ", " ");

export const activePATReactivityKey = ["pats", "active"] as const;
