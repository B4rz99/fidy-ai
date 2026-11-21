import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { DateTime, Effect, Option, Schema } from "effect";
import { Budget, type BudgetStatusQueryParameters } from "../../../src/core/budgets/contract";
import type { UserId } from "../../../src/core/identity/contract";
import { readLocalTransactionAggregate } from "../../transactions/operations";
import { type budgetParameters, budgetPeriod } from "./budget-queries";
import { assembleBudgetReport } from "./budget-report";
import {
  budgetSuccess,
  currentUserMonth,
  localMonth,
  missingBudget,
  plannedBudgets,
} from "./sqlite-planning";
import { encodeBudgetWorkspace } from "./workspace-encoding";

const workspace = Effect.fn(function* (
  user: UserId,
  query: typeof BudgetStatusQueryParameters.Type,
  current: number
) {
  const period = budgetPeriod({ now: DateTime.makeUnsafe(current), query });
  const month = localMonth({ now: period.from, zone: query.timeZone });
  const caps = yield* plannedBudgets(user, Option.some(month), Option.none());
  const sql = yield* SqliteClient;

  const initialized =
    (yield* sql`SELECT 1 FROM budget_month_plan_records WHERE kind='plan' AND user_id=${user} AND month=${month}`)
      .length === 1;

  const aggregates = yield* readLocalTransactionAggregate(
    user,
    period.from.epochMilliseconds,
    period.to.epochMilliseconds
  );

  const report = yield* assembleBudgetReport({
    budgets: caps.active,
    aggregates,
    period,
    query,
    initialized,
  });

  return budgetSuccess(yield* encodeBudgetWorkspace({ ...report, budgets: caps.budgets }));
});

export const queryLocalBudget = Effect.fn(function* (
  parameters: Option.Option.Value<ReturnType<typeof budgetParameters>>,
  user: UserId,
  current: number
) {
  if (Option.isSome(parameters.query)) {
    return yield* workspace(user, parameters.query.value, current);
  }

  const month = yield* currentUserMonth(user, current);
  const { budgets } = yield* plannedBudgets(user, Option.some(month), parameters.id);

  if (Option.isNone(parameters.id)) {
    return budgetSuccess(
      yield* Schema.encodeEffect(Schema.toCodecJson(Schema.Array(Budget)))(budgets)
    );
  }

  const [budget] = budgets;

  return budget === undefined
    ? missingBudget()
    : budgetSuccess(yield* Schema.encodeEffect(Schema.toCodecJson(Budget))(budget));
});
