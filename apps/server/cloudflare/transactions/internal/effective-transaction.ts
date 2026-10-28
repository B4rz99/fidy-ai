/** Exposes the effective_transaction relation. Bind the explicit User id before any other query parameters. */
export type EffectiveTransactionRelation = Readonly<{
  sql: string;
  bindings: ReadonlyArray<string>;
}>;

/** Publish the sole effective Transaction policy to a User-scoped D1 query. */
export const effectiveTransactionRelation = (userId: string): EffectiveTransactionRelation => ({
  sql: `linked_decision AS (SELECT user_id, first_transaction_id, second_transaction_id,
      visible_transaction_id FROM transaction_reconciliation_decisions
      WHERE user_id = ? AND state = 'linked'),
    linked_member AS (SELECT decision.first_transaction_id, decision.second_transaction_id,
      retained.id FROM linked_decision decision JOIN transactions retained
        INDEXED BY sqlite_autoindex_transactions_2
        ON retained.user_id = decision.user_id
        AND retained.id IN (decision.first_transaction_id, decision.second_transaction_id)),
    effective_transaction AS (SELECT * FROM transaction_effective_source WHERE user_id = ?)`,
  bindings: [userId, userId],
});

/**
 * Read effective History from the complete current projection, or the authoritative source while
 * that projection is absent or being repaired. Readiness and facts share the caller's SQL snapshot.
 * Filters and ordering must apply to these effective facts, never to retained pair members.
 * The caller supplies reviewed static SQL with an explicit User predicate, corresponding bound
 * values and a bounded positive page limit. Request values never become SQL fragments.
 */
export const effectiveHistoryPage = ({
  userId,
  where,
  bindings,
  limit,
}: Readonly<{
  userId: string;
  where: string;
  bindings: ReadonlyArray<string | number | Uint8Array>;
  limit: number;
}>): Readonly<{ sql: string; bindings: ReadonlyArray<string | number | Uint8Array> }> => {
  const relation = effectiveTransactionRelation(userId);
  const fields = [
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
  ];
  const presentation = fields
    .map((field) =>
      field === "occurred_at" || field === "created_at"
        ? `strftime('%Y-%m-%dT%H:%M:%fZ',${field}_ms/1000.0,'unixepoch') AS ${field}`
        : field
    )
    .join(", ");
  const ordered = `ORDER BY occurred_at_ms DESC, created_at_ms DESC, id DESC LIMIT ${limit}`;
  // SQLite compound ORDER BY keys must be result columns. Canonical row decoding omits these
  // numeric keys: https://www.sqlite.org/lang_select.html#orderby
  return {
    sql: `WITH readiness AS MATERIALIZED (SELECT EXISTS (
        SELECT 1 FROM transaction_projection_state
        WHERE user_id = ? AND version = 1 AND readiness = 'ready') AS available),
      ${relation.sql},
      repair_page AS (
        SELECT ${presentation}, occurred_at_ms, created_at_ms FROM effective_transaction
        WHERE (${where}) ORDER BY occurred_at_ms DESC, created_at_ms DESC, id DESC
        LIMIT CASE WHEN (SELECT available FROM readiness) THEN 0 ELSE ${limit} END)
      SELECT ${presentation}, occurred_at_ms, created_at_ms
        FROM transaction_projection_leaf
        WHERE user_id = CASE WHEN (SELECT available FROM readiness) THEN ? END
          AND (${where})
      UNION ALL
      SELECT * FROM repair_page
      ${ordered}`,
    bindings: [userId, ...relation.bindings, ...bindings, userId, ...bindings],
  };
};
