import { DateTime } from "effect";

export const monthLabel = (month: string): string =>
  DateTime.format(DateTime.makeUnsafe(`${month}-01`), {
    locale: "es-CO",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });

export const shortMonthLabel = (month: string): string =>
  DateTime.format(DateTime.makeUnsafe(`${month}-01`), {
    locale: "es-CO",
    month: "short",
    timeZone: "UTC",
  }).replace(".", "");
