import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";

/** Adds exact Category/Currency monthly Budgets and future alert idempotency state. */
export const monthlyBudgets = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE budgets (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category_id uuid NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
      cap_amount numeric NOT NULL CHECK (cap_amount > 0),
      cap_currency text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (user_id, category_id, cap_currency)
    )
  `;
  yield* sql`
    CREATE INDEX budgets_user_currency_category_idx
      ON budgets (user_id, cap_currency, category_id, id)
  `;

  yield* sql`
    CREATE TABLE budget_month_latches (
      budget_id uuid NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
      period_from timestamptz NOT NULL,
      period_to timestamptz NOT NULL CHECK (period_to > period_from),
      applied_time_zone text NOT NULL,
      reached_80 boolean NOT NULL DEFAULT false,
      reached_100 boolean NOT NULL DEFAULT false,
      PRIMARY KEY (budget_id, period_from),
      CHECK (NOT reached_100 OR reached_80)
    )
  `;

  yield* sql`
    ALTER TABLE budgets ENABLE ROW LEVEL SECURITY;
    ALTER TABLE budgets FORCE ROW LEVEL SECURITY;
    CREATE POLICY budgets_by_user ON budgets
      USING (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
      WITH CHECK (user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid)
  `;
  yield* sql`
    ALTER TABLE budget_month_latches ENABLE ROW LEVEL SECURITY;
    ALTER TABLE budget_month_latches FORCE ROW LEVEL SECURITY;
    CREATE POLICY budget_month_latches_by_user ON budget_month_latches
      USING (EXISTS (
        SELECT 1 FROM budgets
        WHERE budgets.id = budget_month_latches.budget_id
          AND budgets.user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid
      ))
      WITH CHECK (EXISTS (
        SELECT 1 FROM budgets
        WHERE budgets.id = budget_month_latches.budget_id
          AND budgets.user_id = NULLIF(current_setting('fidy.user_id', true), '')::uuid
      ))
  `;

  yield* sql`
    GRANT SELECT, INSERT, UPDATE, DELETE ON budgets, budget_month_latches TO fidy_runtime
  `;
}).pipe(Effect.asVoid);
