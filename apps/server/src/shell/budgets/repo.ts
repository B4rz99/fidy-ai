import { BigDecimal, DateTime, Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { IanaTimeZone } from "~/core/_shared/context";
import { type Currency, Money, encodeMoneyAmount } from "~/core/_shared/money";
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
import {
  type BudgetContributionFact,
  selectBudgetContributionsInScope,
} from "~/shell/transactions/reads";

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
const budgetFromRow = Effect.fn((row: typeof BudgetFlatRow.Type) =>
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
export const selectBudgetsInScope = Effect.fn("selectBudgetsInScope")(function* (userId: UserId) {
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
export const selectBudgets = Effect.fn("selectBudgets")((userId: UserId) =>
  withUserTransaction(userId, selectBudgetsInScope(userId))
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

const contributionKey = (fact: Readonly<{ categoryId: CategoryId; currency: Currency }>): string =>
  `${fact.categoryId}:${fact.currency}`;

const statusFromBudget = Effect.fn(function* (
  budget: Budget,
  contribution: Option.Option<BudgetContributionFact>,
  period: AppliedBudgetMonth
) {
  const spent = Option.match(contribution, {
    onNone: () => Money.make({ amount: BigDecimal.make(0n, 0), currency: budget.cap.currency }),
    onSome: (fact) => fact.spent,
  });
  return yield* calculateBudgetStatus({ budget, spent, period }).pipe(Effect.orDie);
});

/** Loads filtered monthly status inside the caller's User-scoped transaction. */
export const selectBudgetStatusesInScope = Effect.fn("selectBudgetStatusesInScope")(function* (
  userId: UserId,
  query: BudgetStatusQuery,
  period: AppliedBudgetMonth
) {
  const sql = yield* SqlClient.SqlClient;
  const conditions = [sql`user_id = ${userId}`];
  if (Option.isSome(query.categoryId)) {
    conditions.push(sql`category_id = ${query.categoryId.value}`);
  }
  if (Option.isSome(query.currency)) {
    conditions.push(sql`cap_currency = ${query.currency.value}`);
  }
  const rows = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: BudgetFlatRow,
    execute: () => sql`
      SELECT ${sql.literal(budgetColumns)} FROM budgets
      WHERE ${sql.and(conditions)}
      ORDER BY cap_currency, category_id, id
    `,
  })(undefined).pipe(Effect.orDie);
  const budgets = yield* Effect.forEach(rows, budgetFromRow).pipe(Effect.orDie);
  const contributions = yield* selectBudgetContributionsInScope(userId, {
    from: period.from,
    to: period.to,
    scopes: budgets.map((budget) => ({
      categoryId: budget.categoryId,
      currency: budget.cap.currency,
    })),
  });
  const contributionByScope = new Map(contributions.map((fact) => [contributionKey(fact), fact]));
  return yield* Effect.forEach(budgets, (budget) =>
    statusFromBudget(
      budget,
      Option.fromUndefinedOr(
        contributionByScope.get(
          contributionKey({ categoryId: budget.categoryId, currency: budget.cap.currency })
        )
      ),
      period
    )
  );
});

/** Loads filtered monthly status under an independently established User transaction. */
export const selectBudgetStatuses = Effect.fn("selectBudgetStatuses")(
  (userId: UserId, query: BudgetStatusQuery, period: AppliedBudgetMonth) =>
    withUserTransaction(userId, selectBudgetStatusesInScope(userId, query, period))
);
