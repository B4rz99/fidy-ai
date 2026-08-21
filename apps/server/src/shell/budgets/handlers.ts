import { Effect, Option } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ResolvedCaller } from "~/shell/_shared/authz";
import { resolveFreeSuggestedOperationCaller } from "~/shell/_shared/suggested-operations";
import { FidyApi } from "~/shell/api";
import { createBudget, deleteBudget, updateBudget } from "./mutations";
import { getBudget, getBudgetStatus, listBudgets } from "./queries";

/** Provides User-scoped Budget CRUD and read-only current-calendar-month status. */
export const BudgetsLive = HttpApiBuilder.group(FidyApi, "budgets", (handlers) =>
  handlers
    .handle("createBudget", ({ payload }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveFreeSuggestedOperationCaller;
        return yield* createBudget({ userId, caller, payload });
      })
    )
    .handle("listBudgets", () =>
      Effect.gen(function* () {
        const { subjectUserId } = yield* ResolvedCaller;
        return yield* listBudgets({ userId: subjectUserId });
      })
    )
    .handle("getBudget", ({ params }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveFreeSuggestedOperationCaller;
        return yield* getBudget({ userId, budgetId: params.id, caller });
      })
    )
    .handle("updateBudget", ({ params, payload }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveFreeSuggestedOperationCaller;
        return yield* updateBudget({ userId, caller, budgetId: params.id, payload });
      })
    )
    .handle("deleteBudget", ({ params }) =>
      Effect.gen(function* () {
        const { userId, caller } = yield* resolveFreeSuggestedOperationCaller;
        return yield* deleteBudget({ userId, caller, budgetId: params.id });
      })
    )
    .handle("getBudgetStatus", ({ query }) =>
      Effect.gen(function* () {
        const { subjectUserId } = yield* ResolvedCaller;
        return yield* getBudgetStatus({
          userId: subjectUserId,
          categoryId: Option.fromUndefinedOr(query.categoryId),
          currency: Option.fromUndefinedOr(query.currency),
          timeZone: query.timeZone,
        });
      })
    )
);
