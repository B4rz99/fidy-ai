import type { OwnedStatement } from "../../../src/shell/owner-write/contract";

/** Exposes the effective_transaction relation. Bind the explicit User id before any other query parameters. */
export type EffectiveTransactionRelation = Readonly<{
  sql: string;
  bindings: ReadonlyArray<string>;
}>;

/** Publish the sole effective Transaction policy to a User-scoped D1 query. */
const relationFor = (
  userSql: string,
  bindings: ReadonlyArray<string>
): EffectiveTransactionRelation => ({
  sql: `linked_decision AS (SELECT user_id, first_transaction_id, second_transaction_id,
      visible_transaction_id FROM transaction_reconciliation_decisions
      WHERE user_id = ${userSql} AND state = 'linked'),
    linked_member AS (SELECT decision.first_transaction_id, decision.second_transaction_id,
      retained.id FROM linked_decision decision JOIN transactions retained
        INDEXED BY sqlite_autoindex_transactions_2
        ON retained.user_id = decision.user_id
        AND retained.id IN (decision.first_transaction_id, decision.second_transaction_id)),
    effective_transaction AS (SELECT * FROM transaction_effective_source WHERE user_id = ${userSql})`,
  bindings: [...bindings, ...bindings],
});

/** Publish the sole effective Transaction policy to an explicit User-scoped D1 query. */
export const effectiveTransactionRelation = (userId: string): EffectiveTransactionRelation =>
  relationFor("?", [userId]);

type HistoryFilters = Readonly<{
  where: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
  limit: number;
}>;

const presentation = [
  "user_id",
  "id",
  "amount",
  "currency",
  "direction",
  "counterparty",
  "category_id",
  "notes",
  "occurred_at",
  "created_at",
  "revision",
]
  .map((field) =>
    field === "occurred_at" || field === "created_at"
      ? `strftime('%Y-%m-%dT%H:%M:%fZ',${field}_ms/1000.0,'unixepoch') AS ${field}`
      : field
  )
  .join(", ");

/**
 * Read effective History from the complete current projection, or the authoritative source while
 * that projection is absent or being repaired. Readiness and facts share the caller's SQL snapshot.
 * Filters and ordering must apply to these effective facts, never to retained pair members.
 * The caller supplies reviewed static SQL with an explicit User predicate, corresponding bound
 * values and a bounded positive page limit. Request values never become SQL fragments.
 */
const historyPage = ({
  userSql,
  userBindings,
  prefix,
  where,
  bindings,
  limit,
}: HistoryFilters &
  Readonly<{
    userSql: string;
    userBindings: ReadonlyArray<string>;
    prefix: OwnedStatement;
  }>): Readonly<{ sql: string; bindings: ReadonlyArray<string | number | Uint8Array> }> => {
  const relation = relationFor(userSql, userBindings);
  const ordered = `ORDER BY occurred_at_ms DESC, created_at_ms DESC, id DESC LIMIT ${limit}`;
  // SQLite compound ORDER BY keys must be result columns. Canonical row decoding omits these
  // numeric keys: https://www.sqlite.org/lang_select.html#orderby
  return {
    sql: `WITH ${prefix.sql}readiness AS MATERIALIZED (SELECT EXISTS (
        SELECT 1 FROM transaction_projection_state
        WHERE user_id = ${userSql} AND version = 1 AND readiness = 'ready') AS available),
      ${relation.sql},
      repair_page AS (
        SELECT ${presentation}, occurred_at_ms, created_at_ms FROM effective_transaction
        WHERE (${where}) ORDER BY occurred_at_ms DESC, created_at_ms DESC, id DESC
        LIMIT CASE WHEN (SELECT available FROM readiness) THEN 0 ELSE ${limit} END)
      SELECT ${presentation}, occurred_at_ms, created_at_ms
        FROM transaction_projection_leaf
        WHERE user_id = CASE WHEN (SELECT available FROM readiness) THEN ${userSql} END
          AND (${where})
      UNION ALL
      SELECT * FROM repair_page
      ${ordered}`,
    bindings: [
      ...prefix.params,
      ...userBindings,
      ...relation.bindings,
      ...bindings,
      ...userBindings,
      ...bindings,
    ],
  };
};
/** Read a bounded effective page for the caller's explicit User. */
export const effectiveHistoryPage = ({
  userId,
  ...filters
}: HistoryFilters & Readonly<{ userId: string }>): ReturnType<typeof historyPage> =>
  historyPage({
    ...filters,
    userSql: "?",
    userBindings: [userId],
    prefix: { sql: "", params: [] },
  });

/** The caller supplies an owner-prepared, at-most-one-row live selection with a userId column.
 * Keep its bound proof in one CTE; every projection and repair path selects that same User.
 */
export const selectedEffectiveHistoryPage = ({
  userSelection,
  ...filters
}: HistoryFilters & Readonly<{ userSelection: OwnedStatement }>): ReturnType<typeof historyPage> =>
  historyPage({
    ...filters,
    userSql: "(SELECT userId FROM transaction_history_user)",
    userBindings: [],
    prefix: {
      sql: `transaction_history_user AS (${userSelection.sql}), `,
      params: userSelection.params,
    },
  });
