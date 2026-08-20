import { Schema } from "effect";

/** Stable identity of one User-owned RecurringSeries, retained across later confirmations. */
export const RecurringSeriesId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("RecurringSeriesId"))
  .annotate({ identifier: "RecurringSeriesId" });
export type RecurringSeriesId = typeof RecurringSeriesId.Type;

/**
 * The repeating interval a series was confirmed at, named rather than expressed as a day count.
 * The names are the published vocabulary: the day spans and tolerances one detector matches them
 * with are its own business and never reach a consumer, so a detector may be replaced without
 * changing what a RecurringSeries means.
 */
export const RecurringCadence = Schema.Literals([
  "weekly",
  "fortnightly",
  "monthly",
  "quarterly",
  "yearly",
]).annotate({
  identifier: "RecurringCadence",
  description:
    "How often the charge repeats. It describes the observed rhythm of the series, not a promise " +
    "about exactly when the next one lands.",
});
export type RecurringCadence = typeof RecurringCadence.Type;
