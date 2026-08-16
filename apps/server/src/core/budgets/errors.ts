import { Data } from "effect";
import { type Currency } from "~/core/_shared/money";
import { type CategoryId } from "~/core/categories/reference";
import { type BudgetId } from "./reference";

/** The requested Budget is absent or does not belong to the current User. */
export class BudgetNotFound extends Data.TaggedError("BudgetNotFound")<{
  readonly budgetId: BudgetId;
}> {}

/** Another Budget already owns this User/Category/Currency scope. */
export class BudgetAlreadyExists extends Data.TaggedError("BudgetAlreadyExists")<{
  readonly categoryId: CategoryId;
  readonly currency: Currency;
}> {}

/** A Budget's denomination cannot be changed in place. */
export class BudgetCurrencyImmutable extends Data.TaggedError("BudgetCurrencyImmutable")<{
  readonly expected: Currency;
  readonly received: Currency;
}> {}

/** Closed domain failure set produced while managing one User's Budgets. */
export type BudgetFailure = BudgetNotFound | BudgetAlreadyExists | BudgetCurrencyImmutable;
