import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { Option, Schema } from "effect";
import { Money } from "../../../src/core/_shared/money";
import { Category } from "../../../src/core/categories/contract";
import { Transaction } from "../../../src/core/transactions/contract";

import type { DashboardTransactionFact } from "../contract";

const TransactionRow = Schema.Struct({
  id: Transaction.fields.id,
  amount: Schema.String,
  currency: Money.fields.currency,
  direction: Transaction.fields.direction,
  counterparty: Schema.NullOr(Schema.String),
  notes: Schema.NullOr(Schema.String),
  category_id: Category.fields.id,
  occurred_at: Schema.String,
  created_at: Schema.String,
  revision: Transaction.fields.revision,
});

const decodeTransactionFact = (
  raw: unknown,
  categories: ReadonlyArray<Category>
): Option.Option<DashboardTransactionFact> =>
  Option.flatMap(Schema.decodeUnknownOption(TransactionRow)(raw), (row) =>
    Option.flatMap(
      Schema.decodeOption(Schema.toCodecJson(Transaction))({
        id: row.id,
        money: { amount: row.amount, currency: row.currency },
        direction: row.direction,
        categoryId: row.category_id,
        ...Option.match(Option.fromNullOr(row.counterparty), {
          onNone: () => ({}),
          onSome: (counterparty) => ({ counterparty }),
        }),
        ...Option.match(Option.fromNullOr(row.notes), {
          onNone: () => ({}),
          onSome: (notes) => ({ notes }),
        }),
        occurredAt: row.occurred_at,
        createdAt: row.created_at,
        revision: row.revision,
      }),
      (transaction) =>
        Option.map(
          Option.fromUndefinedOr(categories.find((category) => category.id === row.category_id)),
          (category) => ({ transaction, category })
        )
    )
  );

export const decodeDashboardTransactions = ({
  rows,
  categories,
}: Readonly<{ rows: ReadonlyArray<unknown>; categories: ReadonlyArray<Category> }>): Option.Option<
  ReadonlyArray<DashboardTransactionFact>
> => Option.all(rows.map((row) => decodeTransactionFact(row, categories)));

const selectedColumns = `effective.id, effective.amount, effective.currency,
  effective.direction, effective.counterparty, effective.notes, effective.category_id,
  strftime('%Y-%m-%dT%H:%M:%fZ',effective.occurred_at_ms/1000.0,'unixepoch') AS occurred_at, strftime('%Y-%m-%dT%H:%M:%fZ',effective.created_at_ms/1000.0,'unixepoch') AS created_at, effective.revision`;

const selectedFrom = `FROM transaction_projection_leaf effective`;

const recentOrder = `effective.occurred_at_ms DESC, effective.created_at_ms DESC, effective.id DESC`;

const categoryWindowOrder = `occurred_at_ms DESC, created_at_ms DESC, id DESC`;

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

type ListInput = Readonly<{
  userId: string;
  categories: ReadonlyArray<string>;
  search: Option.Option<string>;
  limit: number;
}>;

const recentCategoryPage = ({ userId, categories, limit }: ListInput): OwnedStatement => {
  const windows = categories.map(
    () => `SELECT id FROM (
    SELECT id FROM transaction_projection_leaf INDEXED BY transaction_projection_leaf_category_recent
    WHERE user_id = ? AND category_id = ? ORDER BY ${categoryWindowOrder} LIMIT ?)`
  );

  const bindings = categories.flatMap((category) => [userId, category, limit]);

  return {
    sql: `WITH selected AS (${windows.join(" UNION ALL ")})
    SELECT ${selectedColumns} ${selectedFrom}
    JOIN selected ON selected.id = effective.id
    WHERE effective.user_id = ? ORDER BY ${recentOrder} LIMIT ?`,
    params: [...bindings, userId, limit],
  };
};

const searchPage = ({ userId, categories, search, limit }: ListInput): OwnedStatement => {
  const categoryPredicate =
    categories.length === 0
      ? ""
      : `AND effective.category_id IN (${categories.map(() => "?").join(",")})`;

  const text = Option.getOrThrow(search).toLocaleLowerCase("es-CO");

  return {
    sql: `SELECT ${selectedColumns}
    FROM transaction_projection_leaf effective INDEXED BY transaction_projection_leaf_recent
    WHERE effective.user_id = ?
      ${categoryPredicate} AND instr(lower(${listSearchText}), ?) > 0
    ORDER BY ${recentOrder} LIMIT ?`,
    params: [userId, ...categories, text, limit],
  };
};

export const dashboardListStatement = ({
  userId,
  categories,
  search,
  limit,
}: ListInput): OwnedStatement => {
  if (Option.isSome(search)) return searchPage({ userId, categories, search, limit });

  if (categories.length > 0) return recentCategoryPage({ userId, categories, search, limit });

  return {
    sql: `SELECT ${selectedColumns} ${selectedFrom}
    WHERE effective.user_id = ? ORDER BY ${recentOrder} LIMIT ?`,
    params: [userId, limit],
  };
};
