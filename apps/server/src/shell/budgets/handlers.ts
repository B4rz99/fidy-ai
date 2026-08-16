import { DateTime, Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { type IanaTimeZone } from "~/core/_shared/context";
import { type Currency } from "~/core/_shared/money";
import { BudgetNotFound } from "~/core/budgets/errors";
import {
  type BudgetStatusQuery,
  BudgetStatusQuery as BudgetStatusQuerySchema,
} from "~/core/budgets/model";
import { deriveCurrentBudgetMonth } from "~/core/budgets/rules";
import { type CategoryId } from "~/core/categories/reference";
import { ResolvedCaller } from "~/shell/_shared/authz";
import { makeFreeSuggestedOperationCaller } from "~/shell/_shared/suggested-operations";
import { FidyApi } from "~/shell/api";
import { toApiFailure } from "./errors";
import { createBudget, deleteBudget, updateBudget } from "./mutations";
import { findBudget, listBudgetStatuses, listBudgets } from "./repo";

const toStatusQuery = (
  categoryId: Option.Option<CategoryId>,
  currency: Option.Option<Currency>,
  timeZone: IanaTimeZone
): BudgetStatusQuery => BudgetStatusQuerySchema.make({ categoryId, currency, timeZone });

const getBudgetForCaller = Effect.fn("getBudgetForCaller")(function* (
  budgetId: Parameters<typeof findBudget>[1]
) {
  const { scopes, subjectUserId } = yield* ResolvedCaller;
  const caller = makeFreeSuggestedOperationCaller(scopes);
  return yield* findBudget(subjectUserId, budgetId).pipe(
    Effect.flatMap(Effect.fromOption(() => new BudgetNotFound({ budgetId }))),
    Effect.mapError((failure) => toApiFailure({ failure, caller }))
  );
});

const getCurrentBudgetStatuses = Effect.fn("getCurrentBudgetStatuses")(function* (
  categoryId: Option.Option<CategoryId>,
  currency: Option.Option<Currency>,
  timeZone: IanaTimeZone
) {
  const { subjectUserId } = yield* ResolvedCaller;
  const query = toStatusQuery(categoryId, currency, timeZone);
  const period = deriveCurrentBudgetMonth({
    now: yield* DateTime.now,
    timeZone: query.timeZone,
  });
  const statuses = yield* listBudgetStatuses(subjectUserId, query, period);
  return { period, statuses };
});

/** Provides User-scoped Budget CRUD and read-only current-calendar-month status. */
export const BudgetsLive = HttpApiBuilder.group(FidyApi, "budgets", (handlers) =>
  handlers
    .handle("createBudget", ({ payload }) =>
      Effect.gen(function* () {
        const { scopes, subjectUserId } = yield* ResolvedCaller;
        return yield* createBudget({
          userId: subjectUserId,
          caller: makeFreeSuggestedOperationCaller(scopes),
          payload,
        });
      })
    )
    .handle("listBudgets", () =>
      Effect.gen(function* () {
        const { subjectUserId } = yield* ResolvedCaller;
        return { data: yield* listBudgets(subjectUserId), next: [] };
      })
    )
    .handle("getBudget", ({ params }) =>
      Effect.map(getBudgetForCaller(params.id), (data) => ({
        data,
        next: [],
      }))
    )
    .handle("updateBudget", ({ params, payload }) =>
      Effect.gen(function* () {
        const { scopes, subjectUserId } = yield* ResolvedCaller;
        return yield* updateBudget({
          userId: subjectUserId,
          caller: makeFreeSuggestedOperationCaller(scopes),
          budgetId: params.id,
          payload,
        });
      })
    )
    .handle("deleteBudget", ({ params }) =>
      Effect.gen(function* () {
        const { scopes, subjectUserId } = yield* ResolvedCaller;
        return yield* deleteBudget({
          userId: subjectUserId,
          caller: makeFreeSuggestedOperationCaller(scopes),
          budgetId: params.id,
        });
      })
    )
    .handle("getBudgetStatus", ({ query }) =>
      Effect.map(
        getCurrentBudgetStatuses(
          Option.fromUndefinedOr(query.categoryId),
          Option.fromUndefinedOr(query.currency),
          query.timeZone
        ),
        (data) => ({ data, next: [] })
      )
    )
);
