import {
  type BudgetAlreadyExists,
  type BudgetCurrencyImmutable,
  type BudgetFailure,
  type BudgetNotFound,
} from "~/core/budgets/errors";
import { type CategoryNotFound } from "~/core/categories/errors";
import { NotFound, ValidationFailed } from "~/shell/_shared/errors";
import type { SuggestedOperation } from "~/shell/_shared/response";
import {
  type SuggestedOperationCaller,
  checkpointSuggestedOperations,
  suggestOperation,
} from "~/shell/_shared/suggested-operations";
import { toApiFailure as categoryToApiFailure } from "~/shell/categories/errors";

const budgetRecovery = (caller: SuggestedOperationCaller): ReadonlyArray<SuggestedOperation> =>
  checkpointSuggestedOperations({
    candidates: [
      suggestOperation({
        tool: "budgets.listBudgets",
        hint: "List Budgets to inspect their stable ids, Categories, caps, and Currencies.",
      }),
    ],
    caller,
  });

type FailureInput<Failure extends BudgetFailure> = Readonly<{
  failure: Failure;
  caller: SuggestedOperationCaller;
}>;

export function toApiFailure(input: FailureInput<BudgetNotFound>): NotFound;
export function toApiFailure(
  input: FailureInput<BudgetAlreadyExists | BudgetCurrencyImmutable>
): ValidationFailed;
export function toApiFailure(input: FailureInput<BudgetFailure>): NotFound | ValidationFailed;
export function toApiFailure({
  failure,
  caller,
}: FailureInput<BudgetFailure>): NotFound | ValidationFailed {
  switch (failure._tag) {
    case "BudgetNotFound":
      return NotFound.make({
        error: {
          code: "not_found",
          message: "That Budget was not found. List Budgets to find one you can change.",
        },
        next: budgetRecovery(caller),
      });
    case "BudgetAlreadyExists":
      return ValidationFailed.make({
        error: {
          code: "validation_failed",
          message: "Only one Budget may exist for the same Category and Currency.",
          fields: [
            {
              path: "categoryId",
              message: `A ${failure.currency} Budget already exists for this Category. Update it instead.`,
            },
          ],
        },
        next: budgetRecovery(caller),
      });
    case "BudgetCurrencyImmutable":
      return ValidationFailed.make({
        error: {
          code: "validation_failed",
          message:
            "A Budget Currency cannot be changed in place. Delete it and create another Budget.",
          fields: [
            {
              path: "cap.currency",
              message: `Expected ${failure.expected}, received ${failure.received}.`,
            },
          ],
        },
        next: budgetRecovery(caller),
      });
  }
}

/** Maps an unknown Category through the shared Category recovery vocabulary. */
export const mapBudgetCategoryFailure = ({
  failure,
  caller,
}: Readonly<{ failure: CategoryNotFound; caller: SuggestedOperationCaller }>): NotFound =>
  categoryToApiFailure({ failure, caller });
