import type { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { CanonicalAdmissionUnavailable } from "../canonical-admission/contract";
import { Context, Data, Effect, type Option, Schema } from "effect";
import { BudgetCrossing } from "../../src/core/budgets/contract";
import { ConsentRecordId } from "../../src/core/consent/contract";
import type { AppliedBudgetMonth, BudgetId } from "../../src/core/budgets/contract";
import type { UserId } from "../../src/core/identity/contract";

/** One mutation's frozen crossing set, with its immutable detection-time delivery eligibility. */
export const BudgetCrossingGroup = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  grantId: Schema.OptionFromNullOr(ConsentRecordId),
  crossings: Schema.NonEmptyArray(BudgetCrossing).check(Schema.isMaxLength(2)),
});
export type BudgetCrossingGroup = typeof BudgetCrossingGroup.Type;

/** Explicit owned month whose historical crossing facts a coordinated peer may observe. */
export type BudgetCrossingRead = Readonly<{
  db: D1Database;
  userId: UserId;
  budgetId: BudgetId;
  period: AppliedBudgetMonth;
}>;

/** Crossing facts are malformed, unavailable or predate historical snapshot retention; current facts cannot substitute for them. */
export class BudgetCrossingUnavailable extends Data.TaggedError("BudgetCrossingUnavailable") {}

/** The Budget whose guarded write the canonical unit commits or whose deletion it proves. */
export type BudgetOutcome = Readonly<{
  _tag: "Budget";
  operation: "budgets.createBudget" | "budgets.updateBudget" | "budgets.deleteBudget";
  budgetId: BudgetId;
  month: Option.Option<string>;
}>;

export type BudgetQueryOperation =
  | "budgets.listBudgets"
  | "budgets.getBudget"
  | "budgets.getBudgetStatus";

type EvaluateThresholds = (
  user: UserId,
  current: number
) => Effect.Effect<void, CanonicalAdmissionUnavailable, SqliteClient>;
/** Financial owners publish each effective change inside their original User transaction. */
export const BudgetThresholdEvaluation = Context.Reference<EvaluateThresholds>(
  "@fidy/cloudflare/budgets/ThresholdEvaluation",
  {
    defaultValue: (): EvaluateThresholds => () =>
      Effect.fail(new CanonicalAdmissionUnavailable({ cause: "missing_budget_owner" })),
  }
);
