import { Option, Schema } from "effect";
import { Money } from "../../src/core/_shared/money";
import { Category } from "../../src/core/categories/model";
import { Transaction } from "../../src/core/transactions/model";
import {
  type EffectiveTransactionRelation,
  effectiveTransactionRelation,
} from "./effective-transaction";

/** Transaction-owned, User-scoped storage interface for Dashboard fact queries. */
export type DashboardTransactionFact = Readonly<{ transaction: Transaction; category: Category }>;
export const maximumDashboardAggregateFacts = 8192;

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

/** Decode a returned page without treating malformed retained Transactions as empty results. */
export const decodeDashboardTransactions = (
  rows: ReadonlyArray<unknown>
): Option.Option<ReadonlyArray<DashboardTransactionFact>> =>
  Option.all(rows.map(decodeTransactionFact));

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
      LIMIT ${maximumDashboardAggregateFacts + 1}`)
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
  categories,
  search,
  limit,
}: Readonly<{
  db: D1Database;
  relation: EffectiveTransactionRelation;
  userId: string;
  categories: ReadonlyArray<string>;
  search: Option.Option<string>;
  limit: number;
}>): D1PreparedStatement => {
  const filter =
    categories.length > 0
      ? `AND effective.category_id IN (${categories.map(() => "?").join(",")})`
      : "";
  const searchPredicate = Option.isNone(search) ? "" : `AND instr(lower(${listSearchText}), ?) > 0`;
  return db
    .prepare(`WITH ${relation.sql} SELECT ${selectedColumns} ${selectedFrom}
      WHERE effective.user_id = ? ${filter} ${searchPredicate}
      ORDER BY effective.occurred_at DESC, effective.created_at DESC, effective.id DESC
      LIMIT ?`)
    .bind(
      ...relation.bindings,
      userId,
      ...categories,
      ...Option.match(search, {
        onNone: () => [],
        onSome: (value) => [value.toLocaleLowerCase("es-CO")],
      }),
      limit
    );
};

/** Publish prepared, User-scoped Transaction queries; caller owns the encompassing D1 batch. */
export const dashboardTransactionQueries = ({
  db,
  userId,
  needsTotals,
  lists,
}: Readonly<{
  db: D1Database;
  userId: string;
  needsTotals: boolean;
  lists: ReadonlyArray<
    Readonly<{
      categories: ReadonlyArray<string>;
      search: Option.Option<string>;
      limit: number;
    }>
  >;
}>): ReadonlyArray<D1PreparedStatement> => {
  const relation = effectiveTransactionRelation(userId);
  return [
    prepareTotals({ db, relation, userId, needed: needsTotals }),
    ...lists.map(({ categories, search, limit }) =>
      prepareList({ db, relation, userId, categories, search, limit })
    ),
  ];
};
