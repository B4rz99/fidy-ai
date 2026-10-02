import { Option, Schema } from "effect";
import { Money } from "../../src/core/_shared/money";
import { Category } from "../../src/core/categories/contract";
import { Transaction } from "../../src/core/transactions/model";

/** Transaction-owned, User-scoped storage interface for Dashboard fact queries. */
export type DashboardTransactionFact = Readonly<{ transaction: Transaction; category: Category }>;

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
        ...(row.counterparty === null ? {} : { counterparty: row.counterparty }),
        ...(row.notes === null ? {} : { notes: row.notes }),
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

/** Decode a returned page without treating malformed retained Transactions as empty results. */
export const decodeDashboardTransactions = ({
  rows,
  categories,
}: Readonly<{ rows: ReadonlyArray<unknown>; categories: ReadonlyArray<Category> }>): Option.Option<
  ReadonlyArray<DashboardTransactionFact>
> => Option.all(rows.map((row) => decodeTransactionFact(row, categories)));

const selectedColumns = `effective.id, effective.amount, effective.currency,
  effective.direction, effective.counterparty, effective.notes, effective.category_id,
  effective.occurred_at, effective.created_at, effective.revision`;
const selectedFrom = `FROM dashboard_projection_leaf effective`;
const recentOrder = `effective.occurred_at DESC, effective.created_at DESC, effective.id DESC`;
const categoryWindowOrder = `occurred_at DESC, created_at DESC, id DESC`;

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

type ListInput = Readonly<{
  db: D1Database;
  userId: string;
  categories: ReadonlyArray<string>;
  search: Option.Option<string>;
  limit: number;
}>;

const recentCategoryPage = ({ db, userId, categories, limit }: ListInput): D1PreparedStatement => {
  const windows = categories.map(
    () => `SELECT id FROM (
    SELECT id FROM dashboard_projection_leaf INDEXED BY dashboard_projection_leaf_category_recent
    WHERE user_id = ? AND category_id = ? ORDER BY ${categoryWindowOrder} LIMIT ?)`
  );
  const bindings = categories.flatMap((category) => [userId, category, limit]);
  return db
    .prepare(`WITH selected AS (${windows.join(" UNION ALL ")})
    SELECT ${selectedColumns} ${selectedFrom}
    JOIN selected ON selected.id = effective.id
    WHERE effective.user_id = ? ORDER BY ${recentOrder} LIMIT ?`)
    .bind(...bindings, userId, limit);
};

const indexedSearchText = (text: string): string => {
  const codePoints = Array.from(text).length;
  if (codePoints === 1) return `§${text}§`;
  if (codePoints === 2) return `§${text}`;
  return text;
};

const searchPage = ({ db, userId, categories, search, limit }: ListInput): D1PreparedStatement => {
  const categoryPredicate =
    categories.length === 0
      ? ""
      : `AND effective.category_id IN (${categories.map(() => "?").join(",")})`;
  const text = Option.getOrThrow(search).toLocaleLowerCase("es-CO");
  // FTS5's trigram index narrows candidates; the exact predicate preserves the established
  // accent-aware substring semantics for returned effective Transactions.
  const phrase = `"${indexedSearchText(text).replaceAll('"', '""')}"`;
  return db
    .prepare(`SELECT ${selectedColumns}
    FROM dashboard_projection_list_search
    JOIN dashboard_projection_leaf effective
      ON effective.rowid = dashboard_projection_list_search.rowid
    WHERE dashboard_projection_list_search MATCH ? AND effective.user_id = ?
      ${categoryPredicate} AND instr(lower(${listSearchText}), ?) > 0
    ORDER BY ${recentOrder} LIMIT ?`)
    .bind(phrase, userId, ...categories, text, limit);
};

const recentPage = ({ db, userId, categories, search, limit }: ListInput): D1PreparedStatement => {
  if (Option.isSome(search)) return searchPage({ db, userId, categories, search, limit });
  if (categories.length > 0) return recentCategoryPage({ db, userId, categories, search, limit });
  return db
    .prepare(`SELECT ${selectedColumns} ${selectedFrom}
    WHERE effective.user_id = ? ORDER BY ${recentOrder} LIMIT ?`)
    .bind(userId, limit);
};

/** Publish indexed, User-scoped effective list pages; caller owns the encompassing D1 batch. */
export const dashboardTransactionQueries = ({
  db,
  userId,
  lists,
}: Readonly<{
  db: D1Database;
  userId: string;
  lists: ReadonlyArray<
    Readonly<{
      categories: ReadonlyArray<string>;
      search: Option.Option<string>;
      limit: number;
    }>
  >;
}>): ReadonlyArray<D1PreparedStatement> =>
  lists.map(({ categories, search, limit }) =>
    recentPage({ db, userId, categories, search, limit })
  );
