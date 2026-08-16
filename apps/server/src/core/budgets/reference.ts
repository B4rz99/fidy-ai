import { Schema } from "effect";

/** Stable identity of one User-owned monthly Budget. */
export const BudgetId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("BudgetId"))
  .annotate({ identifier: "BudgetId" });
export type BudgetId = typeof BudgetId.Type;
