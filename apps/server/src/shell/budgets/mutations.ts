import { DateTime, Effect, Option, type Schema } from "effect";
import {
  BudgetAlreadyExists,
  BudgetCurrencyImmutable,
  BudgetNotFound,
} from "~/core/budgets/errors";
import { type Budget, type CreateBudgetInput, type UpdateBudgetInput } from "~/core/budgets/model";
import { type BudgetId } from "~/core/budgets/reference";
import { deriveCurrentBudgetMonth } from "~/core/budgets/rules";
import { CategoryNotFound } from "~/core/categories/errors";
import { type CategoryId } from "~/core/categories/reference";
import type { UserId } from "~/core/identity/reference";
import type { CanonicalMutationImplementation } from "~/shell/_shared/canonical-mutation";
import type { NotFound, ValidationFailed } from "~/shell/_shared/errors";
import type { OperationResponse } from "~/shell/_shared/response";
import type { SuggestedOperationCaller } from "~/shell/_shared/suggested-operations";
import { findCategory } from "~/shell/categories/repo";
import { advisoryLockKey, withUserLockInScope } from "~/shell/db/advisory-lock";
import { findUserInScope } from "~/shell/identity/repo";
import { mapBudgetCategoryFailure, toApiFailure } from "./errors";
import {
  deleteBudgetInScope,
  findBudgetInScope,
  initializeBudgetMonthLatchInScope,
  insertBudgetInScope,
  selectBudgetsInScope,
  updateBudgetInScope,
} from "./repo";

type MutationResponse<Data extends Schema.Top> = ReturnType<typeof OperationResponse<Data>>["Type"];
type BudgetApiFailure = NotFound | ValidationFailed;

type BudgetMutationContext = Readonly<{
  userId: UserId;
  caller: SuggestedOperationCaller;
}>;

const requireCategory = Effect.fn("requireBudgetCategory")(
  (categoryId: CategoryId, caller: SuggestedOperationCaller) =>
    findCategory(categoryId).pipe(
      Effect.flatMap(Effect.fromOption(() => new CategoryNotFound({ categoryId }))),
      Effect.mapError((failure) => mapBudgetCategoryFailure({ failure, caller }))
    )
);

const requireBudget = Effect.fn("requireBudget")(
  (userId: UserId, budgetId: BudgetId, caller: SuggestedOperationCaller) =>
    findBudgetInScope(userId, budgetId).pipe(
      Effect.flatMap(Effect.fromOption(() => new BudgetNotFound({ budgetId }))),
      Effect.mapError((failure) => toApiFailure({ failure, caller }))
    )
);

type DuplicateCheck = Readonly<{
  budgets: ReadonlyArray<Budget>;
  input: CreateBudgetInput;
  excluding: Option.Option<BudgetId>;
  caller: SuggestedOperationCaller;
}>;

const rejectDuplicate = ({
  budgets,
  input,
  excluding,
  caller,
}: DuplicateCheck): Effect.Effect<void, ValidationFailed> => {
  const duplicate = budgets.some(
    (budget) =>
      !Option.contains(excluding, budget.id) &&
      budget.categoryId === input.categoryId &&
      budget.cap.currency === input.cap.currency
  );
  return duplicate
    ? Effect.fail(
        toApiFailure({
          failure: new BudgetAlreadyExists({
            categoryId: input.categoryId,
            currency: input.cap.currency,
          }),
          caller,
        })
      )
    : Effect.void;
};

const currentUserMonth = Effect.fn("currentUserMonth")(function* (userId: UserId) {
  const user = yield* findUserInScope(userId).pipe(Effect.flatMap(Effect.fromOption), Effect.orDie);
  const now = yield* DateTime.now;
  return deriveCurrentBudgetMonth({ now, timeZone: user.timeZone });
});

export type CreateBudgetMutationInput = BudgetMutationContext &
  Readonly<{ payload: CreateBudgetInput }>;

/** Creates one unique Budget and initializes its current User-zone alert marks. */
export const createBudget: CanonicalMutationImplementation<
  CreateBudgetMutationInput,
  MutationResponse<typeof Budget>,
  BudgetApiFailure
> = Effect.fn("createBudget")(function* ({ userId, caller, payload }) {
  yield* requireCategory(payload.categoryId, caller);
  const budget = yield* withUserLockInScope(
    advisoryLockKey.budgets(userId),
    Effect.gen(function* () {
      yield* rejectDuplicate({
        budgets: yield* selectBudgetsInScope(userId),
        input: payload,
        excluding: Option.none(),
        caller,
      });
      const created = yield* insertBudgetInScope(userId, payload);
      yield* initializeBudgetMonthLatchInScope(created.id, yield* currentUserMonth(userId), false);
      return created;
    })
  );
  return { data: budget, next: [] };
});

export type UpdateBudgetMutationInput = BudgetMutationContext &
  Readonly<{ budgetId: BudgetId; payload: UpdateBudgetInput }>;

/** Updates Category/cap, rejects Currency replacement, and resets marks after Category change. */
export const updateBudget: CanonicalMutationImplementation<
  UpdateBudgetMutationInput,
  MutationResponse<typeof Budget>,
  BudgetApiFailure
> = Effect.fn("updateBudget")(function* ({ userId, caller, budgetId, payload }) {
  yield* requireCategory(payload.categoryId, caller);
  const budget = yield* withUserLockInScope(
    advisoryLockKey.budgets(userId),
    Effect.gen(function* () {
      const current = yield* requireBudget(userId, budgetId, caller);
      if (current.cap.currency !== payload.cap.currency) {
        return yield* toApiFailure({
          failure: new BudgetCurrencyImmutable({
            expected: current.cap.currency,
            received: payload.cap.currency,
          }),
          caller,
        });
      }
      yield* rejectDuplicate({
        budgets: yield* selectBudgetsInScope(userId),
        input: payload,
        excluding: Option.some(budgetId),
        caller,
      });
      const updated = yield* updateBudgetInScope(userId, budgetId, payload).pipe(
        Effect.flatMap(Effect.fromOption(() => new BudgetNotFound({ budgetId }))),
        Effect.mapError((failure) => toApiFailure({ failure, caller }))
      );
      yield* initializeBudgetMonthLatchInScope(
        updated.id,
        yield* currentUserMonth(userId),
        current.categoryId !== updated.categoryId
      );
      return updated;
    })
  );
  return { data: budget, next: [] };
});

export type DeleteBudgetMutationInput = BudgetMutationContext & Readonly<{ budgetId: BudgetId }>;

/** Physically deletes one Budget and its cascading operational alert marks. */
export const deleteBudget: CanonicalMutationImplementation<
  DeleteBudgetMutationInput,
  MutationResponse<typeof BudgetId>,
  NotFound
> = Effect.fn("deleteBudget")(function* ({ userId, caller, budgetId }) {
  const deleted = yield* deleteBudgetInScope(userId, budgetId).pipe(
    Effect.flatMap(Effect.fromOption(() => new BudgetNotFound({ budgetId }))),
    Effect.mapError((failure) => toApiFailure({ failure, caller }))
  );
  return { data: deleted, next: [] };
});
