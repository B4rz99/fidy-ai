import { type BudgetOutcome } from "../contract";
import { Budget, BudgetId } from "../../../src/core/budgets/contract";
import { type Cause, Effect, Option, Schema } from "effect";

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
  month,
}: Readonly<{
  db: D1Database;
  userId: string;
  id: BudgetId;
  month: Option.Option<string>;
}>): Effect.Effect<Option.Option<Budget>, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      db
        .prepare(
          `SELECT b.id,b.category_id,
          COALESCE((SELECT g.currency FROM (SELECT rowid,user_id,group_name,month,currency FROM budget_month_plan_records WHERE kind='currency') g WHERE g.user_id=b.user_id AND g.group_name=b.group_name AND g.month<=COALESCE(?,'9999-12') ORDER BY g.month DESC LIMIT 1),b.currency) AS currency,
          CASE WHEN ? IS NULL THEN b.cap ELSE COALESCE((SELECT p.cap FROM (SELECT rowid,user_id,budget_id,month,cap FROM budget_month_plan_records WHERE kind='cap') p
            WHERE p.user_id=b.user_id AND p.budget_id=b.id AND p.month<=? ORDER BY p.month DESC LIMIT 1),b.cap) END AS cap,
          b.created_at,b.updated_at,b.group_name FROM budgets b WHERE b.user_id=? AND b.id=?`
        )
        .bind(Option.getOrNull(month), Option.getOrNull(month), Option.getOrNull(month), userId, id)
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
    : findOwnedBudget({ db, userId, id: outcome.budgetId, month: outcome.month }).pipe(
        Effect.map(
          Option.map((budget) => ({
            _tag: "Owner" as const,
            payload: budget,
            encode: () => Schema.encodeEffect(Schema.toCodecJson(Budget))(budget),
          }))
        ),
        Effect.orElseSucceed(() => Option.none<CommittedMutationValue>())
      );

/** The Budget owner retains its identity and committed readback. */
export const budgetOutcome = (outcome: BudgetOutcome): OwnerOutcome => ({
  _tag: "Owner",
  operation: outcome.operation,
  guardFacts: Option.some(outcome),
  collisionKey: Option.none(),
  read: (db, userId) => findBudgetValue({ db, userId, outcome }),
});
