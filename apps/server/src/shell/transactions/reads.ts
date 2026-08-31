import { type DateTime, Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema, type Statement } from "effect/unstable/sql";
import { CategoryId } from "~/core/categories/reference";
import { normalizeCategoryKeyword } from "~/core/categories/rules";
import type { IanaTimeZone } from "~/core/_shared/context";
import { Currency, Money, type ReadonlyMoney } from "~/core/_shared/money";
import type { MoneyAggregation, SpendingGroupBy } from "~/core/dashboard/model";
import { UserId } from "~/core/identity/reference";
import {
  type SourceAttestation,
  Transaction,
  type TransactionId,
  type TransactionQuery,
} from "~/core/transactions/model";
import { withUserTransaction } from "~/shell/db/user-transaction";
import { dashboardListStatement, dashboardMetricStatement } from "./read-statements";
import {
  SourceAttestationRow,
  TransactionFlatRow,
  TransactionLookup,
  sourceAttestationColumns,
  sourceAttestationFromRow,
  transactionColumns,
  transactionFromRow,
} from "./rows";

/**
 * Resolves a requested original Transaction to its ordinary presentation. A member is one of the
 * two original Transactions in a reversible link; only `independent` is reachable before links
 * exist.
 */
export type TransactionPresentation =
  | Readonly<{
      kind: "independent";
      requestedId: TransactionId;
      transaction: Transaction;
    }>
  | Readonly<{
      kind: "visible-member";
      requestedId: TransactionId;
      transaction: Transaction;
    }>
  | Readonly<{
      kind: "suppressed-member";
      requestedId: TransactionId;
      visibleId: TransactionId;
      transaction: Transaction;
    }>;

/** Resolves one active User-owned Transaction; foreign, deleted, and absent ids return None. */
export const findTransactionPresentation = Effect.fn("findTransactionPresentation")(function* (
  userId: UserId,
  id: TransactionId
) {
  return yield* withUserTransaction(
    userId,
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      SqlSchema.findOneOption({
        Request: TransactionLookup,
        Result: TransactionFlatRow,
        execute: (request) => sql`
        SELECT ${sql.literal(transactionColumns)}
        FROM transactions
        WHERE id = ${request.id} AND user_id = ${request.userId} AND deleted_at IS NULL
      `,
      })({ id, userId })
    ).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Option.none<TransactionPresentation>()),
          onSome: (row) =>
            transactionFromRow(row).pipe(
              Effect.map((transaction): TransactionPresentation => ({
                kind: "independent",
                requestedId: id,
                transaction,
              })),
              Effect.map(Option.some)
            ),
        })
      ),
      Effect.orDie
    )
  );
});

const containsCounterparty = (counterparty: Option.Option<string>, normalized: string): boolean =>
  Option.exists(counterparty, (candidate) =>
    normalizeCategoryKeyword(candidate).includes(normalized)
  );

const selectTransactionRowsInScope = Effect.fn("selectTransactionRowsInScope")(function* (
  userId: UserId,
  query: TransactionQuery,
  rowLimit: Option.Option<number>
) {
  const sql = yield* SqlClient.SqlClient;
  const conditions = [sql`user_id = ${userId}`, sql`deleted_at IS NULL`];
  if (Option.isSome(query.from)) conditions.push(sql`occurred_at >= ${query.from.value}`);
  if (Option.isSome(query.to)) conditions.push(sql`occurred_at < ${query.to.value}`);
  if (Option.isSome(query.categoryId)) {
    conditions.push(sql`category_id = ${query.categoryId.value}`);
  }
  if (Option.isSome(query.direction)) {
    conditions.push(sql`direction = ${query.direction.value}`);
  }
  if (Option.isSome(query.currency)) conditions.push(sql`currency = ${query.currency.value}`);
  const limitClause = Option.match(rowLimit, {
    onNone: () => sql``,
    onSome: (limit) => sql`LIMIT ${limit}`,
  });

  const rows = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: TransactionFlatRow,
    execute: () => sql`
      SELECT ${sql.literal(transactionColumns)}
      FROM transactions
      WHERE ${sql.and(conditions)}
      ORDER BY occurred_at DESC, created_at DESC, id DESC
      ${limitClause}
    `,
  })(undefined).pipe(Effect.orDie);
  const transactions: ReadonlyArray<Transaction> = yield* Effect.forEach(
    rows,
    transactionFromRow
  ).pipe(Effect.orDie);
  const selected: ReadonlyArray<Transaction> = Option.match(query.counterparty, {
    onNone: () => transactions,
    onSome: (counterparty) => {
      const normalized = normalizeCategoryKeyword(counterparty);
      return transactions.filter((transaction) =>
        containsCounterparty(transaction.counterparty, normalized)
      );
    },
  });
  return selected;
});

/** Loads active matching Transactions inside the caller's User-scoped transaction. */
export const selectTransactionsInScope = Effect.fn("selectTransactionsInScope")(
  (userId: UserId, query: TransactionQuery) =>
    selectTransactionRowsInScope(userId, query, Option.none())
);

/** Closed grouping dimensions supported by the selective Dashboard aggregate query. */
export type DashboardTransactionGroup = SpendingGroupBy;

/** Half-open UTC period applied by Dashboard aggregate queries. */
export type DashboardTransactionPeriod = Readonly<{
  from: DateTime.Utc;
  toExclusive: DateTime.Utc;
}>;

/**
 * Purpose-specific spending query. An empty Category list includes every Category; calendar keys
 * are derived in `timeZone`, and the result is grouped exactly by the requested dimension.
 */
export type DashboardTransactionSumQuery = DashboardTransactionPeriod &
  Readonly<{
    categories: ReadonlyArray<CategoryId>;
    groupBy: DashboardTransactionGroup;
    timeZone: IanaTimeZone;
  }>;

/** One exact Currency-and-direction sum for a single requested grouping key. */
export type DashboardTransactionSumFact = Readonly<{
  key:
    | Readonly<{ kind: "category"; categoryId: CategoryId }>
    | Readonly<{ kind: "day"; date: string }>
    | Readonly<{ kind: "month"; month: string }>;
  direction: "inflow" | "outflow";
  money: ReadonlyMoney;
}>;

const DashboardSumRow = Schema.Struct({
  categoryId: Schema.OptionFromNullOr(CategoryId),
  date: Schema.OptionFromNullOr(Schema.String),
  month: Schema.OptionFromNullOr(Schema.String),
  currency: Currency,
  direction: Transaction.fields.direction,
  amount: Money.fields.amount,
});

const decodeDashboardMoney = (currency: Currency, amount: ReadonlyMoney["amount"]): ReadonlyMoney =>
  Schema.decodeSync(Schema.toType(Money))({ currency, amount });

const dashboardSumKey = (
  row: typeof DashboardSumRow.Type,
  groupBy: DashboardTransactionGroup
): DashboardTransactionSumFact["key"] => {
  const keys = {
    category: (): DashboardTransactionSumFact["key"] => ({
      kind: "category",
      categoryId: Option.getOrThrow(row.categoryId),
    }),
    day: (): DashboardTransactionSumFact["key"] => ({
      kind: "day",
      date: Option.getOrThrow(row.date),
    }),
    month: (): DashboardTransactionSumFact["key"] => ({
      kind: "month",
      month: Option.getOrThrow(row.month),
    }),
  };
  return keys[groupBy]();
};

type DashboardSumGrouping = Readonly<{
  select: Statement.Fragment;
  group: Statement.Fragment;
  order: Statement.Fragment;
}>;

const dashboardSumGrouping = (
  sql: SqlClient.SqlClient,
  query: Pick<DashboardTransactionSumQuery, "groupBy" | "timeZone">
): DashboardSumGrouping => {
  switch (query.groupBy) {
    case "category":
      return {
        select: sql`transaction.category_id AS "categoryId",
          NULL::text AS date, NULL::text AS month`,
        group: sql`transaction.category_id`,
        order: sql`transaction.category_id`,
      };
    case "day":
      return {
        select: sql`NULL::uuid AS "categoryId",
          to_char(transaction.occurred_at AT TIME ZONE ${query.timeZone}, 'YYYY-MM-DD') AS date,
          NULL::text AS month`,
        group: sql`date`,
        order: sql`date`,
      };
    case "month":
      return {
        select: sql`NULL::uuid AS "categoryId", NULL::text AS date,
          to_char(transaction.occurred_at AT TIME ZONE ${query.timeZone}, 'YYYY-MM') AS month`,
        group: sql`month`,
        order: sql`month`,
      };
  }
};

/** Selects exact grouped Dashboard sums without materializing matching Transactions. */
export const selectDashboardTransactionSumsInScope = Effect.fn(
  "selectDashboardTransactionSumsInScope"
)(function* (userId: UserId, query: DashboardTransactionSumQuery) {
  const sql = yield* SqlClient.SqlClient;
  const conditions = [
    sql`transaction.user_id = ${userId}`,
    sql`transaction.deleted_at IS NULL`,
    sql`transaction.occurred_at >= ${query.from}`,
    sql`transaction.occurred_at < ${query.toExclusive}`,
  ];
  if (query.categories.length > 0) {
    conditions.push(sql`transaction.category_id IN ${sql.in(query.categories)}`);
  }
  const grouping = dashboardSumGrouping(sql, query);
  const rows = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: DashboardSumRow,
    execute: () => sql`
      SELECT ${grouping.select}, transaction.currency, transaction.direction,
        SUM(transaction.amount) AS amount
      FROM transactions transaction
      WHERE ${sql.and(conditions)}
      GROUP BY ${grouping.group}, transaction.currency, transaction.direction
      ORDER BY ${grouping.order}, transaction.currency, transaction.direction
    `,
  })(undefined).pipe(Effect.orDie);
  const facts: ReadonlyArray<DashboardTransactionSumFact> = rows.map((row) => ({
    key: dashboardSumKey(row, query.groupBy),
    direction: row.direction,
    money: decodeDashboardMoney(row.currency, row.amount),
  }));
  return facts;
});

/** Metric query whose empty Category list includes every active Transaction in the period. */
export type DashboardTransactionMetricQuery = DashboardTransactionPeriod &
  Readonly<{
    aggregation: MoneyAggregation;
    categories: ReadonlyArray<CategoryId>;
  }>;

/** Exact SQL aggregate required to derive one directional custom metric without row materialization. */
export type DashboardTransactionMetricFact =
  | Readonly<{
      aggregation: "sum" | "maximum";
      direction: "inflow" | "outflow";
      money: ReadonlyMoney;
    }>
  | Readonly<{
      aggregation: "average";
      direction: "inflow" | "outflow";
      sum: ReadonlyMoney;
      count: bigint;
    }>;

const DashboardMetricAmountRow = Schema.Struct({
  currency: Currency,
  direction: Transaction.fields.direction,
  amount: Money.fields.amount,
});

const DashboardMetricAverageRow = Schema.Struct({
  currency: Currency,
  direction: Transaction.fields.direction,
  sum: Money.fields.amount,
  count: Schema.BigIntFromString,
});

/** Selects exact sum/count/maximum groups required by Dashboard custom metrics. */
export const selectDashboardTransactionMetricsInScope = Effect.fn(
  "selectDashboardTransactionMetricsInScope"
)(function* (userId: UserId, query: DashboardTransactionMetricQuery) {
  const sql = yield* SqlClient.SqlClient;
  const statement = dashboardMetricStatement({ sql, userId, query });
  if (query.aggregation === "average") {
    const rows = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: DashboardMetricAverageRow,
      execute: () => statement,
    })(undefined).pipe(Effect.orDie);
    const facts: ReadonlyArray<DashboardTransactionMetricFact> = rows.map((row) => ({
      aggregation: "average" as const,
      direction: row.direction,
      sum: decodeDashboardMoney(row.currency, row.sum),
      count: row.count,
    }));
    return facts;
  }
  const rows = yield* SqlSchema.findAll({
    Request: Schema.Void,
    Result: DashboardMetricAmountRow,
    execute: () => statement,
  })(undefined).pipe(Effect.orDie);
  const aggregation: "sum" | "maximum" = query.aggregation === "sum" ? "sum" : "maximum";
  const facts: ReadonlyArray<DashboardTransactionMetricFact> = rows.map((row) => ({
    aggregation,
    direction: row.direction,
    money: decodeDashboardMoney(row.currency, row.amount),
  }));
  return facts;
});

/**
 * Stable top-K Dashboard list query. An empty Category list includes every Category; `search` must
 * already use shared normalization, and `limit` is the hard maximum returned by PostgreSQL.
 */
export type DashboardTransactionListQuery = Readonly<{
  categories: ReadonlyArray<CategoryId>;
  search: Option.Option<string>;
  searchCategoryIds: ReadonlyArray<CategoryId>;
  limit: number;
}>;

const DashboardTransactionRow = Schema.Struct({
  id: Transaction.fields.id,
  ...Money.fields,
  counterparty: TransactionFlatRow.fields.counterparty,
  direction: TransactionFlatRow.fields.direction,
  categoryId: CategoryId,
  occurredAt: TransactionFlatRow.fields.occurredAt,
});

type DashboardTransactionRow = typeof DashboardTransactionRow.Type;
/** Closed public list projection; private search and ordering fields never cross this interface. */
export type DashboardTransactionProjection = Readonly<
  Omit<DashboardTransactionRow, "amount" | "currency"> & {
    readonly money: ReadonlyMoney;
  }
>;
/** Selects one stable bounded Dashboard Transaction projection before decoding private rows. */
export const selectDashboardTransactionsInScope = Effect.fn("selectDashboardTransactionsInScope")(
  function* (userId: UserId, query: DashboardTransactionListQuery) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* SqlSchema.findAll({
      Request: Schema.Void,
      Result: DashboardTransactionRow,
      execute: () => dashboardListStatement({ sql, userId, query }),
    })(undefined).pipe(Effect.orDie);
    const transactions: ReadonlyArray<DashboardTransactionProjection> = rows.map((row) => ({
      id: row.id,
      money: Money.make({ amount: row.amount, currency: row.currency }),
      counterparty: row.counterparty,
      direction: row.direction,
      categoryId: row.categoryId,
      occurredAt: row.occurredAt,
    }));
    return transactions;
  }
);

/** Loads active Transactions under an independently established User transaction. */
export const selectTransactions = Effect.fn("selectTransactions")(
  (userId: UserId, query: TransactionQuery) =>
    withUserTransaction(userId, selectTransactionsInScope(userId, query))
);

/** One Category/Currency scope whose outflows may contribute to a Budget. */
export type BudgetContributionScope = Readonly<{
  categoryId: CategoryId;
  currency: Currency;
}>;

/** Purpose-specific Budget request over one half-open applied period. */
export type BudgetContributionQuery = Readonly<{
  from: DateTime.Utc;
  to: DateTime.Utc;
  scopes: ReadonlyArray<BudgetContributionScope>;
}>;

/** One exact outflow sum for a requested Category/Currency scope. */
export type BudgetContributionFact = BudgetContributionScope & Readonly<{ spent: ReadonlyMoney }>;

const BudgetContributionRequest = Schema.Struct({
  userId: UserId,
  from: Schema.DateTimeUtc,
  to: Schema.DateTimeUtc,
  categoryIds: Schema.Array(CategoryId),
  currencies: Schema.Array(Currency),
});

const BudgetContributionRow = Schema.Struct({
  categoryId: CategoryId,
  currency: Currency,
  amount: Money.fields.amount,
});

/** Selects exact Budget contributions from active outflows in the applied period. */
export const selectBudgetContributionsInScope = Effect.fn("selectBudgetContributionsInScope")(
  function* (userId: UserId, query: BudgetContributionQuery) {
    if (query.scopes.length === 0) {
      const noContributions: ReadonlyArray<BudgetContributionFact> = [];
      return noContributions;
    }
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* SqlSchema.findAll({
      Request: BudgetContributionRequest,
      Result: BudgetContributionRow,
      execute: (request) => sql`
        WITH requested_scope AS (
          SELECT * FROM unnest(
            ${request.categoryIds}::uuid[], ${request.currencies}::text[]
          ) AS scope(category_id, currency)
        )
        SELECT transaction.category_id AS "categoryId", transaction.currency,
          SUM(transaction.amount) AS amount
        FROM transactions transaction
        INNER JOIN requested_scope scope
          ON scope.category_id = transaction.category_id
          AND scope.currency = transaction.currency
        WHERE transaction.user_id = ${request.userId} AND transaction.deleted_at IS NULL
          AND transaction.direction = 'outflow' AND transaction.occurred_at >= ${request.from}
          AND transaction.occurred_at < ${request.to}
        GROUP BY transaction.category_id, transaction.currency
        ORDER BY transaction.currency, transaction.category_id
      `,
    })({
      userId,
      from: query.from,
      to: query.to,
      categoryIds: query.scopes.map(({ categoryId }) => categoryId),
      currencies: query.scopes.map(({ currency }) => currency),
    }).pipe(Effect.orDie);
    const contributions: ReadonlyArray<BudgetContributionFact> = rows.map((row) => ({
      categoryId: row.categoryId,
      currency: row.currency,
      spent: Money.make({ amount: row.amount, currency: row.currency }),
    }));
    return contributions;
  }
);

/** Lists retained immutable provenance for one User-owned Transaction, including after deletion. */
export const selectSourceAttestations = Effect.fn("selectSourceAttestations")(function* (
  userId: UserId,
  id: TransactionId
) {
  const attestations: ReadonlyArray<SourceAttestation> = yield* withUserTransaction(
    userId,
    Effect.flatMap(SqlClient.SqlClient, (sql) =>
      SqlSchema.findAll({
        Request: TransactionLookup,
        Result: SourceAttestationRow,
        execute: (request) => sql`
        SELECT ${sql.literal(sourceAttestationColumns)}
        FROM source_attestations source
        WHERE source.transaction_id = ${request.id}
          AND EXISTS (
            SELECT 1 FROM transactions transaction
            WHERE transaction.id = source.transaction_id
              AND transaction.user_id = ${request.userId}
          )
        ORDER BY source.created_at, source.id
      `,
      })({ id, userId })
    ).pipe(
      Effect.flatMap((rows) => Effect.forEach(rows, sourceAttestationFromRow)),
      Effect.orDie
    )
  );
  return attestations;
});
