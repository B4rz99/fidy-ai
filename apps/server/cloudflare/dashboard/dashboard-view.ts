import { Effect, Option, Schema } from "effect";

import { Money } from "../../src/core/_shared/money";
import { IanaTimeZone, Locale, ServiceMarket } from "../../src/core/_shared/context";
import { Category } from "../../src/core/categories/model";
import { Budget } from "../../src/core/budgets/model";
import { Transaction } from "../../src/core/transactions/model";
import {
  type DashboardDocument,
  type TransactionListWidget,
  collectLayoutWidgets,
} from "../../src/core/dashboard/model";
import type { DashboardFacts } from "../../src/shell/dashboard/presentation";
import { budgetFromRow } from "../budgets/budget-row";
import {
  type EffectiveTransactionRelation,
  effectiveTransactionRelation,
} from "../transactions/effective-transaction";

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
    transactions: D1Result<unknown>;
    lists: ReadonlyArray<Readonly<{ id: string; result: D1Result<unknown> }>>;
  }>
): Option.Option<DashboardFacts> => {
  const context = Schema.decodeUnknownOption(UserContextRow)(input.userResult.results[0]);
  if (
    Option.isNone(context) ||
    input.budgets.results.length > maximumBudgets ||
    input.transactions.results.length > maximumProjectionFacts
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
  const transactions = Option.all(input.transactions.results.map(decodeTransactionFact));
  const lists = Option.all(
    input.lists.map(({ id, result }) =>
      Option.map(
        Option.all(result.results.map(decodeTransactionFact)),
        (rows) => [id, rows] as const
      )
    )
  );
  return Option.map(Option.all({ categories, budgets, transactions, lists }), (facts) => ({
    ...facts,
    lists: new Map(facts.lists),
    categories: new Map(facts.categories.map((category) => [category.id, category])),
    context: context.value,
  }));
};

const selectedColumns = `effective.id, effective.amount, effective.currency,
  effective.direction, effective.counterparty, effective.notes, effective.category_id, category.label,
  effective.occurred_at, effective.created_at, effective.revision`;
const selectedFrom = `FROM effective_transaction effective
  JOIN categories category ON category.id = effective.category_id`;

const prepareTotals = ({
  db,
  relation,
  userId,
  needed,
}: Readonly<{
  db: D1Database;
  relation: EffectiveTransactionRelation;
  userId: string;
  needed: boolean;
}>): D1PreparedStatement =>
  db
    .prepare(`WITH ${relation.sql} SELECT ${selectedColumns} ${selectedFrom}
      WHERE effective.user_id = ? AND ? = 1
      ORDER BY effective.occurred_at DESC, effective.created_at DESC, effective.id DESC
      LIMIT ${maximumProjectionFacts + 1}`)
    .bind(...relation.bindings, userId, needed ? 1 : 0);

// SQLite's lower() is ASCII-only; fold Spanish capital accents explicitly for es-CO search.
const listSearchText = [
  ["Á", "á"],
  ["É", "é"],
  ["Í", "í"],
  ["Ó", "ó"],
  ["Ú", "ú"],
  ["Ü", "ü"],
  ["Ñ", "ñ"],
].reduce(
  (expression, [upper, lower]) => `replace(${expression}, '${upper}', '${lower}')`,
  "coalesce(effective.counterparty, '') || ' ' || coalesce(effective.notes, '')"
);

const prepareList = ({
  db,
  relation,
  userId,
  widget,
}: Readonly<{
  db: D1Database;
  relation: EffectiveTransactionRelation;
  userId: string;
  widget: TransactionListWidget;
}>): D1PreparedStatement => {
  const categories = widget.categories ?? [];
  const filter =
    categories.length > 0
      ? `AND effective.category_id IN (${categories.map(() => "?").join(",")})`
      : "";
  const search = widget.search === undefined ? "" : `AND instr(lower(${listSearchText}), ?) > 0`;
  return db
    .prepare(`WITH ${relation.sql} SELECT ${selectedColumns} ${selectedFrom}
      WHERE effective.user_id = ? ${filter} ${search}
      ORDER BY effective.occurred_at DESC, effective.created_at DESC, effective.id DESC
      LIMIT ?`)
    .bind(
      ...relation.bindings,
      userId,
      ...categories,
      ...(widget.search === undefined ? [] : [widget.search.toLocaleLowerCase("es-CO")]),
      widget.limit
    );
};

/** Fail closed when current aggregate facts exceed the interim work budget; lists always query a page. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const loadDashboardFacts = (
  db: D1Database,
  userId: string,
  document: DashboardDocument
): Effect.Effect<Option.Option<DashboardFacts>> =>
  Effect.gen(function* () {
    const relation = effectiveTransactionRelation(userId);
    const widgets = collectLayoutWidgets(document.layout);
    const lists = widgets.filter((widget) => widget.type === "transaction-list");
    const needsTotals = widgets.some((widget) => widget.type !== "transaction-list");
    const [userResult, categories, budgets, transactions, ...listResults] =
      yield* Effect.tryPromise(() =>
        db.batch([
          db
            .prepare("SELECT service_market, locale, time_zone FROM users WHERE id = ?")
            .bind(userId),
          db.prepare("SELECT id, label FROM categories ORDER BY display_order LIMIT 32"),
          db
            .prepare(
              "SELECT id, category_id, currency, cap, created_at, updated_at FROM budgets WHERE user_id = ? LIMIT 129"
            )
            .bind(userId),
          prepareTotals({ db, relation, userId, needed: needsTotals }),
          ...lists.map((widget) => prepareList({ db, relation, userId, widget })),
        ])
      );
    if (
      userResult === undefined ||
      categories === undefined ||
      budgets === undefined ||
      transactions === undefined ||
      listResults.length !== lists.length
    ) {
      return Option.none();
    }
    const listPairs = lists.flatMap((widget, index) => {
      const result = listResults[index];
      return result === undefined ? [] : [{ id: widget.id, result }];
    });
    return decodeFacts({ userResult, categories, budgets, transactions, lists: listPairs });
  }).pipe(Effect.orElseSucceed(() => Option.none()));
