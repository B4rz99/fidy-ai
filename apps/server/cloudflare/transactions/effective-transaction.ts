/**
 * The authoritative, User-scoped effective Transaction relation.
 *
 * `dashboard_effective_source` is the Transaction-owned SQL view installed by migration 0020;
 * History, search, projection maintenance, and repair all read the same policy. The retained
 * members are not rewritten on Reconciliation: the SQL view chooses the visible member and each
 * fact group from its latest correction, statement attestation, or explicit User decision.
 * This fragment exposes `effective_transaction` for existing Transaction callers. Always bind
 * the explicit User id before appending any other query parameters.
 */
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
        ON retained.user_id = decision.user_id
        AND retained.id IN (decision.first_transaction_id, decision.second_transaction_id)),
    effective_transaction AS (SELECT * FROM dashboard_effective_source WHERE user_id = ?)`,
  bindings: [userId, userId],
});
