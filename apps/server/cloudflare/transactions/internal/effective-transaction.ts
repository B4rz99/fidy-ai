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
  const columns = fields
    .map((field) => (field === "occurred_at" || field === "created_at" ? `${field}_ms` : field))
    .join(", ");
  const encoded = `json_object(${fields.flatMap((field) => ["'" + field + "'", field === "occurred_at" || field === "created_at" ? `strftime('%Y-%m-%dT%H:%M:%fZ',${field}_ms/1000.0,'unixepoch')` : field]).join(", ")})`;
  const decoded = fields.map((field) => `json_extract(value, '$.${field}') AS ${field}`).join(", ");
  const ordered = `ORDER BY occurred_at_ms DESC, created_at_ms DESC, id DESC LIMIT ${limit}`;
  return {
    sql: `WITH selected AS (SELECT CASE WHEN EXISTS (
        SELECT 1 FROM transaction_projection_state
        WHERE user_id = ? AND version = 1 AND readiness = 'ready')
      THEN (SELECT json_group_array(${encoded}) FROM (
        SELECT ${columns} FROM transaction_projection_leaf WHERE (${where}) ${ordered}))
      ELSE (WITH ${relation.sql} SELECT json_group_array(${encoded}) FROM (
        SELECT ${columns} FROM effective_transaction WHERE (${where}) ${ordered}))
      END AS records)
      SELECT ${decoded} FROM selected, json_each(selected.records) ORDER BY occurred_at DESC, created_at DESC, id DESC LIMIT ${limit}`,
    bindings: [userId, ...bindings, ...relation.bindings, ...bindings],
  };
};
