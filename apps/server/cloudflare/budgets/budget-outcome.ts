import { type Budget, type BudgetId } from "@fidy/server/budgets-runtime";
import { Effect, Option } from "effect";
import { budgetFromRow } from "./budget-row";
import type {
  BudgetOutcome,
  CanonicalMutationRefusal,
  CommittedMutationValue,
} from "../mutations/mutation-types";
import { transactionFailure, transactionUnavailable } from "../transactions/transaction-boundary";

/** One retained Budget by id and stable User; a foreign id resolves to absence. */
export const findOwnedBudget = ({
  db,
  userId,
  id,
}: Readonly<{
  db: D1Database;
  userId: string;
  id: BudgetId;
}>): Promise<Option.Option<Budget>> =>
  db
    .prepare(
      "SELECT id, category_id, currency, cap, created_at, updated_at FROM budgets WHERE user_id = ? AND id = ?"
    )
    .bind(userId, id)
    .first()
    .then(budgetFromRow);

const HTTP_NOT_FOUND = 404;
const HTTP_BAD_REQUEST = 400;

/** A declared Budget refusal at the individual and atomic-batch seams. */
export const budgetRefusal = (
  code: "not_found" | "validation_failed"
): CanonicalMutationRefusal => ({
  code,
  message:
    code === "not_found"
      ? "Budget or Category unavailable."
      : "Budget Category and Currency must be unique; Currency cannot change.",
  record: () => Effect.succeed("recorded" as const),
  respond: () =>
    Effect.succeed(
      transactionFailure({
        code,
        status: code === "not_found" ? HTTP_NOT_FOUND : HTTP_BAD_REQUEST,
        message:
          code === "not_found"
            ? "Budget or Category unavailable."
            : "Budget Category and Currency must be unique; Currency cannot change.",
      })
    ),
});

/** Read one Budget after its shared D1 unit committed; deletion returns only the removed id. */
export const findBudgetValue = ({
  db,
  userId,
  outcome,
}: Readonly<{
  db: D1Database;
  userId: string;
  outcome: BudgetOutcome;
}>): Effect.Effect<Option.Option<CommittedMutationValue>> =>
  outcome.operation === "budgets.deleteBudget"
    ? Effect.succeedSome({ _tag: "RemovedBudget" as const, id: outcome.budgetId })
    : Effect.tryPromise(() => findOwnedBudget({ db, userId, id: outcome.budgetId })).pipe(
        Effect.map(Option.map((budget) => ({ _tag: "Budget" as const, budget }))),
        Effect.orElseSucceed(() => Option.none<CommittedMutationValue>())
      );

/** A Budget owner whose D1 authority cannot decide must fail closed. */
export const unavailableBudget = transactionUnavailable;
