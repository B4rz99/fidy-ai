import { type BudgetOutcome } from "../contract";
import { Budget, BudgetId } from "../../../src/core/budgets/contract";
import { type Cause, Effect, Option, Schema } from "effect";
import { auditLimitRefusal } from "../../canonical-work/operations";
import { budgetFromRow } from "./budget-row";
import {
  type CommittedMutationValue,
  type OwnerOutcome,
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
}>): Effect.Effect<Option.Option<Budget>, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      db
        .prepare(
          "SELECT id, category_id, currency, cap, created_at, updated_at FROM budgets WHERE user_id = ? AND id = ?"
        )
        .bind(userId, id)
        .first()
    );
    return raw === null ? Option.none<Budget>() : Option.some(yield* budgetFromRow(raw));
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
    : findOwnedBudget({ db, userId, id: outcome.budgetId }).pipe(
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
