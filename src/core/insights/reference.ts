import { Schema } from "effect";

/** The four proactive decisions committed by the MVP specification. */
export const InsightKind = Schema.Literals([
  "budget-threshold",
  "new-recurring-series",
  "weekly-summary",
  "manual-entry-reminder",
]);
export type InsightKind = typeof InsightKind.Type;
