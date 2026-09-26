import { Effect, Option, Schema } from "effect";

import { Money } from "../../src/core/_shared/money";
import { IanaTimeZone, Locale, ServiceMarket } from "../../src/core/_shared/context";
import { Category } from "../../src/core/categories/model";
import { Budget } from "../../src/core/budgets/model";
import { Transaction } from "../../src/core/transactions/model";
import type { DashboardFacts } from "../../src/shell/dashboard/presentation";
import { budgetFromRow } from "../budgets/budget-row";
import { effectiveTransactionRelation } from "../transactions/effective-transaction";

const maximumBudgets = 128;
const maximumProjectionFacts = 8192;
const TransactionRow = Schema.Struct({
  id: Transaction.fields.id,
  amount: Schema.String,
  currency: Money.fields.currency,
  direction: Transaction.fields.direction,
  counterparty: Schema.NullOr(Schema.String),
  notes: Schema.NullOr(Schema.String),
  category_id: Category.fields.id,
  label: Category.fields.label,
  occurred_at: Schema.String,
  created_at: Schema.String,
  revision: Transaction.fields.revision,
});
const UserContextRow = Schema.Struct({
  service_market: ServiceMarket,
  locale: Locale,
  time_zone: IanaTimeZone,
});
const BudgetRow = Schema.Struct({
  id: Budget.fields.id,
  category_id: Budget.fields.categoryId,
  currency: Money.fields.currency,
  cap: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
});
type DashboardTransactionFact = Readonly<{ transaction: Transaction; category: Category }>;

const decodeTransactionFact = (raw: unknown): Option.Option<DashboardTransactionFact> =>
  Option.flatMap(Schema.decodeUnknownOption(TransactionRow)(raw), (row) =>
    Option.map(
      Schema.decodeOption(Schema.toCodecJson(Transaction))({
        id: row.id,
        money: { amount: row.amount, currency: row.currency },
        direction: row.direction,
        categoryId: row.category_id,
        ...(row.counterparty === null ? {} : { counterparty: row.counterparty }),
        ...(row.notes === null ? {} : { notes: row.notes }),
        occurredAt: row.occurred_at,
        createdAt: row.created_at,
        revision: row.revision,
      }),
      (transaction) => ({ transaction, category: { id: row.category_id, label: row.label } })
    )
  );

const decodeFacts = (
  input: Readonly<{
    userResult: D1Result<unknown>;
    categories: D1Result<unknown>;
    budgets: D1Result<unknown>;
    movements: D1Result<unknown>;
  }>
): Option.Option<DashboardFacts> => {
  const context = Schema.decodeUnknownOption(UserContextRow)(input.userResult.results[0]);
  if (
    Option.isNone(context) ||
    input.budgets.results.length > maximumBudgets ||
    input.movements.results.length > maximumProjectionFacts
  ) {
    return Option.none();
  }
  const categories = Option.all(
    input.categories.results.map((raw) => Schema.decodeUnknownOption(Category)(raw))
  );
  const budgets = Option.all(
    input.budgets.results.map((raw) =>
      Option.flatMap(Schema.decodeUnknownOption(BudgetRow)(raw), () => budgetFromRow(raw))
    )
  );
  const movements = Option.all(input.movements.results.map(decodeTransactionFact));
  return Option.map(Option.all({ categories, budgets, movements }), (facts) => ({
    ...facts,
    categories: new Map(facts.categories.map((category) => [category.id, category])),
    context: context.value,
  }));
};

/** Fail closed when current facts exceed the per-request work budget; never truncate Currency totals. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const loadDashboardFacts = (
  db: D1Database,
  userId: string
): Effect.Effect<Option.Option<DashboardFacts>> =>
  Effect.gen(function* () {
    const relation = effectiveTransactionRelation(userId);
    const [userResult, categories, budgets, movements] = yield* Effect.tryPromise(() =>
      db.batch([
        db.prepare("SELECT service_market, locale, time_zone FROM users WHERE id = ?").bind(userId),
        db.prepare("SELECT id, label FROM categories ORDER BY display_order LIMIT 32"),
        db
          .prepare(
            "SELECT id, category_id, currency, cap, created_at, updated_at FROM budgets WHERE user_id = ? LIMIT 129"
          )
          .bind(userId),
        db
          .prepare(`WITH ${relation.sql} SELECT movement.id, movement.amount, movement.currency,
        movement.direction, movement.counterparty, movement.notes, movement.category_id, category.label,
        movement.occurred_at, movement.created_at, movement.revision
        FROM effective_transaction movement JOIN categories category ON category.id = movement.category_id
        WHERE movement.user_id = ? ORDER BY movement.occurred_at DESC, movement.created_at DESC, movement.id DESC
        LIMIT ${maximumProjectionFacts + 1}`)
          .bind(...relation.bindings, userId),
      ])
    );
    if (
      userResult === undefined ||
      categories === undefined ||
      budgets === undefined ||
      movements === undefined
    ) {
      return Option.none();
    }
    return decodeFacts({ userResult, categories, budgets, movements });
  }).pipe(Effect.orElseSucceed(() => Option.none()));
