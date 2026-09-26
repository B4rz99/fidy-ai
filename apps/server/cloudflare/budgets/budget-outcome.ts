import { type Budget, type BudgetId } from "@fidy/server/budgets-runtime";
import { Effect, Option } from "effect";
import {
  type TransactionCaller,
  transactionFailure,
  transactionUnavailable,
} from "../transactions/transaction-boundary";
import { recordBudgetCall } from "./budget-audit";
import { budgetFromRow } from "./budget-row";
import type {
  BudgetOutcome,
  CanonicalMutationRefusal,
  CommittedMutationValue,
} from "../mutations/mutation-types";

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

type BudgetMutationOperation = BudgetOutcome["operation"];

/** A declared Budget refusal at the individual and atomic-batch seams. */
export const budgetRefusal = ({
  db,
  subject,
  operation,
  current,
  code,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: BudgetMutationOperation;
  current: number;
  code: "not_found" | "validation_failed";
}>): CanonicalMutationRefusal => ({
  code,
  message: code === "not_found" ? "Budget or Category unavailable." : "Budget input unavailable.",
  record: () => recordBudgetCall({ db, subject, operation, current, outcome: "rejected" }),
  respond: () =>
    Effect.succeed(
      transactionFailure({
        code,
        status: code === "not_found" ? HTTP_NOT_FOUND : HTTP_BAD_REQUEST,
        message:
          code === "not_found" ? "Budget or Category unavailable." : "Budget input unavailable.",
      })
    ),
});

/** An exhausted shared audit budget cannot write another refusal AuditLogEntry. */
export const budgetAuditLimitRefusal = (): CanonicalMutationRefusal => ({
  code: "rate_limited",
  message: "Daily audit budget exhausted.",
  record: () => Effect.succeed("rate_limited" as const),
  respond: () => Effect.succeed(transactionUnavailable()),
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
