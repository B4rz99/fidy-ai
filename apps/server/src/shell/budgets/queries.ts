import { DateTime, Effect, type Option } from "effect";
import type { IanaTimeZone } from "~/core/_shared/context";
import type { Currency } from "~/core/_shared/money";
import { BudgetNotFound } from "~/core/budgets/errors";
import { BudgetStatusQuery } from "~/core/budgets/model";
import type { BudgetId } from "~/core/budgets/reference";
import { deriveCurrentBudgetMonth } from "~/core/budgets/rules";
import type { CategoryId } from "~/core/categories/reference";
import type { UserId } from "~/core/identity/reference";
import type { SuggestedOperationCaller } from "~/shell/_shared/suggested-operations";
import { toApiFailure } from "./errors";
import { findBudget, selectBudgetStatuses, selectBudgets } from "./repo";

/** Reads the caller's own Budgets. */
export const listBudgets = Effect.fn("listBudgets")(function* ({
  userId,
}: Readonly<{ userId: UserId }>) {
  return { data: yield* selectBudgets(userId), next: [] };
});

export type GetBudgetInput = Readonly<{
  userId: UserId;
  budgetId: BudgetId;
  caller: SuggestedOperationCaller;
}>;

/** Reads one caller-owned Budget. Foreign and absent ids are indistinguishable. */
export const getBudget = Effect.fn("getBudget")(function* ({
  userId,
  budgetId,
  caller,
}: GetBudgetInput) {
  const data = yield* findBudget(userId, budgetId).pipe(
    Effect.flatMap(Effect.fromOption(() => new BudgetNotFound({ budgetId }))),
    Effect.mapError((failure) => toApiFailure({ failure, caller }))
  );
  return { data, next: [] };
});

export type GetBudgetStatusInput = Readonly<{
  userId: UserId;
  categoryId: Option.Option<CategoryId>;
  currency: Option.Option<Currency>;
  timeZone: IanaTimeZone;
}>;

/**
 * Reads Budget status for the caller's current calendar month. The period is derived from the
 * caller's time zone rather than accepted from the request, so the answer cannot be shifted.
 */
export const getBudgetStatus = Effect.fn("getBudgetStatus")(function* ({
  userId,
  categoryId,
  currency,
  timeZone,
}: GetBudgetStatusInput) {
  const query = BudgetStatusQuery.make({ categoryId, currency, timeZone });
  const period = deriveCurrentBudgetMonth({ now: yield* DateTime.now, timeZone });
  const statuses = yield* selectBudgetStatuses(userId, query, period);
  return { data: { period, statuses }, next: [] };
});
