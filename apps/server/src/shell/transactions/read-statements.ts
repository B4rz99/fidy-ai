import { type DateTime, Option } from "effect";
import type { SqlClient, Statement } from "effect/unstable/sql";
import { type CategoryId } from "~/core/categories/reference";
import { type MoneyAggregation } from "~/core/dashboard/model";
import { type UserId } from "~/core/identity/reference";
import { searchLikePattern } from "~/core/_shared/search";
import { effectiveTransactionCte, effectiveTransactionPeriodCte } from "./effective-relation";
import { normalizedTransactionSearchSql } from "./search-sql";

type DashboardMetricStatementQuery = Readonly<{
  from: DateTime.Utc;
  toExclusive: DateTime.Utc;
  aggregation: MoneyAggregation;
  categories: ReadonlyArray<CategoryId>;
}>;

const dashboardMetricConditions = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  query: DashboardMetricStatementQuery
): Array<Statement.Fragment> => {
  const conditions = [
    sql`user_id = ${userId}`,
    sql`deleted_at IS NULL`,
    sql`occurred_at >= ${query.from}`,
    sql`occurred_at < ${query.toExclusive}`,
  ];
  if (query.categories.length > 0) {
    conditions.push(sql`category_id IN ${sql.in(query.categories)}`);
  }
  return conditions;
};

/** Builds the private custom-metric statement used by reads and direct query-plan verification. */
export const dashboardMetricStatement = ({
  sql,
  userId,
  query,
}: Readonly<{
  sql: SqlClient.SqlClient;
  userId: UserId;
  query: DashboardMetricStatementQuery;
}>): Statement.Statement<unknown> => {
  const conditions = dashboardMetricConditions(sql, userId, query);
  if (query.aggregation === "average") {
    return sql`
      WITH ${effectiveTransactionPeriodCte({
        sql,
        userId,
        from: query.from,
        toExclusive: query.toExclusive,
      })}
      SELECT currency, direction, SUM(amount) AS sum, COUNT(*)::text AS count
      FROM effective_transaction
      WHERE ${sql.and(conditions)}
      GROUP BY currency, direction
      ORDER BY currency, direction
    `;
  }
  const aggregates = {
    sum: sql`SUM(amount)`,
    maximum: sql`MAX(amount)`,
  };
  return sql`
    WITH ${effectiveTransactionPeriodCte({
      sql,
      userId,
      from: query.from,
      toExclusive: query.toExclusive,
    })}
    SELECT currency, direction, ${aggregates[query.aggregation]} AS amount
    FROM effective_transaction
    WHERE ${sql.and(conditions)}
    GROUP BY currency, direction
    ORDER BY currency, direction
  `;
};

type DashboardListStatementQuery = Readonly<{
  categories: ReadonlyArray<CategoryId>;
  search: Option.Option<string>;
  searchCategoryIds: ReadonlyArray<CategoryId>;
  limit: number;
}>;

const dashboardListConditions = (
  sql: SqlClient.SqlClient,
  userId: UserId,
  query: DashboardListStatementQuery
): Array<Statement.Fragment> => {
  const conditions = [sql`transaction.user_id = ${userId}`, sql`transaction.deleted_at IS NULL`];
  if (query.categories.length > 0) {
    conditions.push(sql`transaction.category_id IN ${sql.in(query.categories)}`);
  }
  return conditions;
};

const dashboardSearchCategoryCondition = (
  sql: SqlClient.SqlClient,
  categoryIds: ReadonlyArray<CategoryId>
): Statement.Fragment =>
  categoryIds.length === 0 ? sql`FALSE` : sql`transaction.category_id IN ${sql.in(categoryIds)}`;

const appendDashboardSearchCondition = (
  sql: SqlClient.SqlClient,
  query: DashboardListStatementQuery,
  conditions: Array<Statement.Fragment>
): void => {
  if (Option.isNone(query.search)) return;
  const pattern = searchLikePattern(query.search.value);
  const categoryMatch = dashboardSearchCategoryCondition(sql, query.searchCategoryIds);
  conditions.push(sql`(
    ${sql.literal(normalizedTransactionSearchSql)} LIKE ${pattern} ESCAPE '\\'
    OR ${categoryMatch}
  )`);
};

/** Builds the private bounded-list statement used by reads and direct query-plan verification. */
export const dashboardListStatement = ({
  sql,
  userId,
  query,
}: Readonly<{
  sql: SqlClient.SqlClient;
  userId: UserId;
  query: DashboardListStatementQuery;
}>): Statement.Statement<unknown> => {
  const conditions = dashboardListConditions(sql, userId, query);
  appendDashboardSearchCondition(sql, query, conditions);
  return sql`
    WITH ${effectiveTransactionCte({ sql, userId })}
    SELECT transaction.id, transaction.amount, transaction.currency,
      transaction.counterparty, transaction.direction,
      transaction.category_id AS "categoryId", transaction.occurred_at AS "occurredAt"
    FROM effective_transaction transaction
    WHERE ${sql.and(conditions)}
    ORDER BY transaction.occurred_at DESC, transaction.created_at DESC, transaction.id DESC
    LIMIT ${query.limit}
  `;
};
