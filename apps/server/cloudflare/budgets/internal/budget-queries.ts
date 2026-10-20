import { deriveCurrentBudgetMonth } from "../../../src/core/budgets/operations";
import type { BudgetQueryOperation } from "../contract";
import {
  type AppliedBudgetMonth,
  BudgetId,
  BudgetStatusQueryParameters,
} from "../../../src/core/budgets/contract";
import { DateTime, Option, Schema } from "effect";

const statusParameters = (url: URL): Option.Option<typeof BudgetStatusQueryParameters.Type> => {
  const keys = [...url.searchParams.keys()];
  if (
    keys.length !== new Set(keys).size ||
    keys.some((key) => !["categoryId", "currency", "timeZone", "month"].includes(key))
  ) {
    return Option.none();
  }
  return Schema.decodeUnknownOption(BudgetStatusQueryParameters)(
    Object.fromEntries(url.searchParams)
  );
};

export const budgetParameters = ({
  operation,
  url,
}: Readonly<{ operation: BudgetQueryOperation; url: URL }>): Option.Option<{
  id: Option.Option<BudgetId>;
  query: Option.Option<typeof BudgetStatusQueryParameters.Type>;
}> => {
  if (operation === "budgets.getBudget") {
    if (url.searchParams.size > 0) return Option.none();
    const id = Schema.decodeOption(BudgetId)(url.pathname.split("/").at(-1) ?? "");
    return Option.isSome(id) ? Option.some({ id, query: Option.none() }) : Option.none();
  }
  if (operation === "budgets.listBudgets") {
    return url.searchParams.size === 0
      ? Option.some({ id: Option.none(), query: Option.none() })
      : Option.none();
  }
  return Option.map(statusParameters(url), (query) => ({
    id: Option.none<BudgetId>(),
    query: Option.some(query),
  }));
};

/** Apply an explicit planning month or the caller's current local calendar month. */
export const budgetPeriod = ({
  now,
  query,
}: Readonly<{
  now: DateTime.Utc;
  query: typeof BudgetStatusQueryParameters.Type;
}>): AppliedBudgetMonth =>
  deriveCurrentBudgetMonth({
    now:
      query.month === undefined
        ? now
        : DateTime.toUtc(
            DateTime.makeZonedUnsafe(`${query.month}-01T00:00:00Z`, {
              timeZone: query.timeZone,
              adjustForTimeZone: true,
            })
          ),
    timeZone: query.timeZone,
  });
