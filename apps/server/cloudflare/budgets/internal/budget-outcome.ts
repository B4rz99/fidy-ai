import type { BudgetOutcome } from "../contract";
import { Budget, BudgetId } from "@fidy/server/budgets-contract";
import { Effect, Option, Schema } from "effect";
import {
  type TransactionCaller,
  auditLimitRefusal,
  transactionFailure,
} from "../../canonical-work/operations";
import { recordBudgetCall } from "./budget-audit";
import { budgetFromRow } from "./budget-row";
import type {
  CanonicalMutationRefusal,
  CommittedMutationValue,
  OwnerOutcome,
} from "../../canonical-operations/contract";

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
    ? Effect.succeedSome({
        _tag: "Owner" as const,
        payload: outcome.budgetId,
        encode: () => Schema.encodeEffect(Schema.toCodecJson(BudgetId))(outcome.budgetId),
      })
    : Effect.tryPromise(() => findOwnedBudget({ db, userId, id: outcome.budgetId })).pipe(
        Effect.map(
          Option.map((budget) => ({
            _tag: "Owner" as const,
            payload: budget,
            encode: () => Schema.encodeEffect(Schema.toCodecJson(Budget))(budget),
          }))
        ),
        Effect.orElseSucceed(() => Option.none<CommittedMutationValue>())
      );

/** Commit-time Budget decisions stay with the owner; only a proved audit trigger is attributed. */
export const budgetOutcome = (outcome: BudgetOutcome): OwnerOutcome => ({
  _tag: "Owner",
  operation: outcome.operation,
  guardFacts: Option.some(outcome),
  collisionKey: Option.none(),
  read: (db, userId) => findBudgetValue({ db, userId, outcome }),
  triggerRefusal: (_work, kind) =>
    kind === "audit" ? Option.some(auditLimitRefusal()) : Option.none(),
});
