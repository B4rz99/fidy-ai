import type { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { CanonicalAdmissionUnavailable } from "../canonical-admission/contract";
import { Context, Effect } from "effect";
import type { UserId } from "../../src/core/identity/contract";

export type BudgetQueryOperation =
  | "budgets.listBudgets"
  | "budgets.getBudget"
  | "budgets.getBudgetStatus";

type EvaluateThresholds = (
  user: UserId,
  current: number
) => Effect.Effect<void, CanonicalAdmissionUnavailable, SqliteClient>;

export const BudgetThresholdEvaluation = Context.Reference<EvaluateThresholds>(
  "@fidy/cloudflare/budgets/ThresholdEvaluation",
  {
    defaultValue: (): EvaluateThresholds => () =>
      Effect.fail(new CanonicalAdmissionUnavailable({ cause: "missing_budget_owner" })),
  }
);
