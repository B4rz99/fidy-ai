import { DateTime, Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { IanaTimeZone } from "~/core/_shared/context";
import { Money, encodeMoneyAmount } from "~/core/_shared/money";
import {
  type AppliedBudgetMonth,
  Budget,
  type BudgetStatusQuery,
  type CreateBudgetInput,
  type UpdateBudgetInput,
} from "~/core/budgets/model";
import { BudgetId } from "~/core/budgets/reference";
import { calculateBudgetStatus } from "~/core/budgets/rules";
import { CategoryId } from "~/core/categories/reference";
import { UserId } from "~/core/identity/reference";
import { withUserTransaction } from "~/shell/db/user-transaction";

const BudgetFlatRow = Schema.Struct({
  id: Schema.toEncoded(Budget.fields.id),
  categoryId: Schema.toEncoded(CategoryId),
  capAmount: Money.fields.amount,
  capCurrency: Money.fields.currency,
  createdAt: Schema.DateTimeUtcFromDate,
  updatedAt: Schema.DateTimeUtcFromDate,
});

const budgetColumns = `id, category_id AS "categoryId", cap_amount AS "capAmount",
  cap_currency AS "capCurrency", created_at AS "createdAt", updated_at AS "updatedAt"`;
const decodeBudget = Schema.decodeUnknownEffect(Budget);
const budgetFromRow = Effect.fn("budgetFromRow")((row: typeof BudgetFlatRow.Type) =>
  decodeBudget({
    id: row.id,
    categoryId: row.categoryId,
    cap: { amount: encodeMoneyAmount(row.capAmount), currency: row.capCurrency },
    createdAt: DateTime.formatIso(row.createdAt),
    updatedAt: DateTime.formatIso(row.updatedAt),
  })
);

const BudgetLookup = Schema.Struct({ userId: UserId, budgetId: BudgetId });

/** Lists one User's Budgets in deterministic Currency, Category, identity order in scope. */
export const listBudgetsInScope = Effect.fn("listBudgetsInScope")(function* (userId: UserId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* SqlSchema.findAll({
    Request: UserId,
    Result: BudgetFlatRow,
    execute: (owner) => sql`
      SELECT ${sql.literal(budgetColumns)} FROM budgets
      WHERE user_id = ${owner}
      ORDER BY cap_currency, category_id, id
    `,
  })(userId).pipe(Effect.orDie);
  return yield* Effect.forEach(rows, budgetFromRow).pipe(Effect.orDie);
});

/** Lists one User's Budgets under an independently established User transaction. */
export const listBudgets = Effect.fn("listBudgets")((userId: UserId) =>
  withUserTransaction(userId, listBudgetsInScope(userId))
);

/** Finds one User-owned Budget in scope; foreign and absent ids are indistinguishable. */
export const findBudgetInScope = Effect.fn("findBudgetInScope")(function* (
  userId: UserId,
  budgetId: BudgetId
) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* SqlSchema.findOneOption({
    Request: BudgetLookup,
    Result: BudgetFlatRow,
    execute: (lookup) => sql`
      SELECT ${sql.literal(budgetColumns)} FROM budgets
      WHERE user_id = ${lookup.userId} AND id = ${lookup.budgetId}
    `,
  })({ userId, budgetId }).pipe(Effect.orDie);
  return yield* Option.match(row, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (found) => budgetFromRow(found).pipe(Effect.map(Option.some), Effect.orDie),
  });
});

/** Finds one User-owned Budget under an independently established User transaction. */
export const findBudget = Effect.fn("findBudget")((userId: UserId, budgetId: BudgetId) =>
  withUserTransaction(userId, findBudgetInScope(userId, budgetId))
);

const BudgetWrite = Schema.Struct({
  userId: UserId,
  categoryId: CategoryId,
  capAmount: Money.fields.amount,
  capCurrency: Money.fields.currency,
});
const writeBudget = (userId: UserId, input: CreateBudgetInput): typeof BudgetWrite.Type => ({
  userId,
  categoryId: input.categoryId,
  capAmount: input.cap.amount,
  capCurrency: input.cap.currency,
});

/** Inserts one Budget in the caller-owned User transaction. */
export const insertBudgetInScope = Effect.fn("insertBudgetInScope")(function* (
  userId: UserId,
  input: CreateBudgetInput
) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* SqlSchema.findOne({
    Request: BudgetWrite,
    Result: BudgetFlatRow,
    execute: (budget) => sql`
      INSERT INTO budgets (user_id, category_id, cap_amount, cap_currency)
      VALUES (${budget.userId}, ${budget.categoryId}, ${budget.capAmount}, ${budget.capCurrency})
      RETURNING ${sql.literal(budgetColumns)}
    `,
  })(writeBudget(userId, input)).pipe(Effect.orDie);
  return yield* budgetFromRow(row).pipe(Effect.orDie);
});

/** Replaces editable facts while retaining identity and Currency in the caller transaction. */
export const updateBudgetInScope = Effect.fn("updateBudgetInScope")(function* (
  userId: UserId,
  budgetId: BudgetId,
  input: UpdateBudgetInput
) {
  const sql = yield* SqlClient.SqlClient;
  const row = yield* SqlSchema.findOneOption({
    Request: Schema.Struct({ ...BudgetWrite.fields, budgetId: BudgetId }),
    Result: BudgetFlatRow,
    execute: (budget) => sql`
      UPDATE budgets SET category_id = ${budget.categoryId}, cap_amount = ${budget.capAmount},
        updated_at = now()
      WHERE user_id = ${budget.userId} AND id = ${budget.budgetId}
        AND cap_currency = ${budget.capCurrency}
      RETURNING ${sql.literal(budgetColumns)}
    `,
  })({ ...writeBudget(userId, input), budgetId }).pipe(Effect.orDie);
  return yield* Option.match(row, {
    onNone: () => Effect.succeed(Option.none()),
    onSome: (found) => budgetFromRow(found).pipe(Effect.map(Option.some), Effect.orDie),
  });
});

/** Physically removes one User-owned Budget and cascades its monthly marks. */
export const deleteBudgetInScope = Effect.fn("deleteBudgetInScope")(function* (
  userId: UserId,
  budgetId: BudgetId
) {
  const sql = yield* SqlClient.SqlClient;
  return yield* SqlSchema.findOneOption({
    Request: BudgetLookup,
    Result: Schema.Struct({ id: BudgetId }),
    execute: (lookup) => sql`
      DELETE FROM budgets WHERE user_id = ${lookup.userId} AND id = ${lookup.budgetId}
      RETURNING id
    `,
  })({ userId, budgetId }).pipe(Effect.map(Option.map((row) => row.id)), Effect.orDie);
});

const LatchWrite = Schema.Struct({
  budgetId: BudgetId,
  from: Schema.DateTimeUtc,
  to: Schema.DateTimeUtc,
  timeZone: IanaTimeZone,
  reset: Schema.Boolean,
});

/** Initializes one monthly latch row, optionally resetting an existing row after Category change. */
export const initializeBudgetMonthLatchInScope = Effect.fn("initializeBudgetMonthLatchInScope")(
  function* (budgetId: BudgetId, period: AppliedBudgetMonth, reset: boolean) {
    const sql = yield* SqlClient.SqlClient;
    yield* SqlSchema.void({
      Request: LatchWrite,
      execute: (latch) => sql`
        INSERT INTO budget_month_latches
          (budget_id, period_from, period_to, applied_time_zone, reached_80, reached_100)
        VALUES (${latch.budgetId}, ${latch.from}, ${latch.to}, ${latch.timeZone}, false, false)
        ON CONFLICT (budget_id, period_from) DO UPDATE SET
          period_to = EXCLUDED.period_to,
          applied_time_zone = EXCLUDED.applied_time_zone,
          reached_80 = CASE WHEN ${latch.reset} THEN false ELSE budget_month_latches.reached_80 END,
          reached_100 = CASE WHEN ${latch.reset} THEN false ELSE budget_month_latches.reached_100 END
      `,
    })({ budgetId, ...period, reset }).pipe(Effect.orDie);
  }
);

const BudgetStatusFlatRow = Schema.Struct({
  ...BudgetFlatRow.fields,
  spentAmount: Money.fields.amount,
});

const statusFromRow = Effect.fn("statusFromRow")(function* (
  row: typeof BudgetStatusFlatRow.Type,
  period: AppliedBudgetMonth
) {
  const budget = yield* budgetFromRow(row);
  return yield* calculateBudgetStatus({
    budget,
    spent: Money.make({ amount: row.spentAmount, currency: row.capCurrency }),
    period,
  }).pipe(Effect.orDie);
});

/** Loads filtered monthly status without mutating Budget or latch state. */
export const listBudgetStatuses = Effect.fn("listBudgetStatuses")(function* (
  userId: UserId,
  query: BudgetStatusQuery,
  period: AppliedBudgetMonth
) {
  return yield* withUserTransaction(
    userId,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const conditions = [sql`budget.user_id = ${userId}`];
      if (Option.isSome(query.categoryId)) {
        conditions.push(sql`budget.category_id = ${query.categoryId.value}`);
      }
      if (Option.isSome(query.currency)) {
        conditions.push(sql`budget.cap_currency = ${query.currency.value}`);
      }
      const rows = yield* SqlSchema.findAll({
        Request: Schema.Void,
        Result: BudgetStatusFlatRow,
        execute: () => sql`
          SELECT budget.id, budget.category_id AS "categoryId",
            budget.cap_amount AS "capAmount", budget.cap_currency AS "capCurrency",
            budget.created_at AS "createdAt", budget.updated_at AS "updatedAt",
            COALESCE(SUM(transaction.amount), 0) AS "spentAmount"
          FROM budgets budget
          LEFT JOIN transactions transaction
            ON transaction.user_id = budget.user_id
            AND transaction.category_id = budget.category_id
            AND transaction.currency = budget.cap_currency
            AND transaction.direction = 'outflow'
            AND transaction.deleted_at IS NULL
            AND transaction.occurred_at >= ${period.from}
            AND transaction.occurred_at < ${period.to}
          WHERE ${sql.and(conditions)}
          GROUP BY budget.id
          ORDER BY budget.cap_currency, budget.category_id, budget.id
        `,
      })(undefined).pipe(Effect.orDie);
      return yield* Effect.forEach(rows, (row) => statusFromRow(row, period)).pipe(Effect.orDie);
    })
  );
});
