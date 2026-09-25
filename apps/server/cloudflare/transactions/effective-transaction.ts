/**
 * The effective Transaction relation for one User: one row per effective Transaction.
 *
 * The fragment publishes three CTEs a caller joins: `linked_decision` holds the User's linked pairs,
 * `linked_member` holds both retained members with the member-fact projections, and
 * `effective_transaction` holds one row per effective Transaction with the same Transaction fact
 * columns the retained `transactions` table exposes, minus its internal `user_decisions`.
 *
 * A retained Transaction that is not a member of a linked Reconciliation decision appears as
 * itself. Each linked pair appears once under its visible member's id, and each effective fact group
 * is read from the member the Transaction-owned policy selected: Money, direction, and occurrence
 * from the latest corrected member, else the latest statement-sourced member, else the visible
 * member; Category, Counterparty, and notes from the latest member that explicitly decided them,
 * else the visible member. Selection is recomputed from the retained members on every read, so a
 * later correction changes the effective Transaction without rewriting either original. `revision` is
 * the visible member's on every effective row, because the visible member is the identity history and
 * search return; a single-record read by a suppressed member's id substitutes that member's revision
 * so its correction compare-and-swaps the value it read.
 *
 * `bindings` are the positionally-ordered User ids the fragment consumes; a caller appends its own
 * `?` bindings after them.
 */
export type EffectiveTransactionRelation = Readonly<{
  sql: string;
  bindings: ReadonlyArray<string>;
}>;

const linkedDecisionCte = `
  linked_decision AS (
    SELECT decision.user_id, decision.first_transaction_id, decision.second_transaction_id,
      decision.visible_transaction_id
    FROM transaction_reconciliation_decisions decision
    WHERE decision.user_id = ? AND decision.state = 'linked'
  )`;

/**
 * The member-fact projections the effective relation derives from one retained Transaction: the
 * latest Correction instant, whether the Transaction has statement provenance, and which fact
 * groups the User explicitly decided. The alias must be a `transactions` row, and the query that
 * embeds the returned comma-separated column list must have `transaction_corrections` and
 * `source_attestations` in scope.
 */
const memberFactColumns = (alias: string): string =>
  `(SELECT MAX(correction.corrected_at) FROM transaction_corrections correction
      WHERE correction.user_id = ${alias}.user_id
        AND correction.transaction_id = ${alias}.id) AS corrected_at,
    EXISTS (SELECT 1 FROM source_attestations source
      WHERE source.user_id = ${alias}.user_id AND source.transaction_id = ${alias}.id
        AND source.kind = 'statement-line') AS has_statement_source,
    COALESCE(json_extract(${alias}.user_decisions, '$.categoryId') = 1, 0) AS category_decided,
    COALESCE(json_extract(${alias}.user_decisions, '$.counterparty') = 1, 0) AS counterparty_decided,
    COALESCE(json_extract(${alias}.user_decisions, '$.notes') = 1, 0) AS notes_decided`;

const linkedMemberCte = `
  linked_member AS (
    SELECT decision.first_transaction_id, decision.second_transaction_id,
      retained.id, retained.amount, retained.currency, retained.direction,
      retained.counterparty, retained.category_id, retained.notes,
      retained.occurred_at, retained.created_at, retained.revision,
      ${memberFactColumns("retained")}
    FROM linked_decision decision
    INNER JOIN transactions retained
      ON retained.user_id = decision.user_id
      AND (retained.id = decision.first_transaction_id
        OR retained.id = decision.second_transaction_id)
  )`;

const authorityMember = (eligibility: string): string =>
  `(SELECT member.id FROM linked_member member
      WHERE member.first_transaction_id = decision.first_transaction_id
        AND member.second_transaction_id = decision.second_transaction_id
        ${eligibility}
      ORDER BY COALESCE(member.corrected_at, member.created_at) DESC, member.id DESC LIMIT 1)`;

// A corrected member outranks a statement-sourced member for Money, direction, and occurrence;
// an explicitly decided member outranks every other member for its own fact group.
const correctedMember = authorityMember("AND member.corrected_at IS NOT NULL");
const statementMember = authorityMember("AND member.has_statement_source = 1");
const decidedMember = (group: "category" | "counterparty" | "notes"): string =>
  authorityMember(`AND member.${group}_decided = 1`);

const effectiveTransactionCte = `
  effective_transaction AS (
    SELECT retained.user_id, retained.id, retained.amount, retained.currency,
      retained.direction, retained.counterparty, retained.category_id, retained.notes,
      retained.occurred_at, retained.created_at, retained.revision
    FROM transactions retained
    WHERE retained.user_id = ?
      AND NOT EXISTS (SELECT 1 FROM transaction_reconciliation_members member
        WHERE member.user_id = retained.user_id AND member.transaction_id = retained.id)
    UNION ALL
    SELECT decision.user_id, decision.visible_transaction_id,
      movement.amount, movement.currency, movement.direction,
      counterparty_member.counterparty, category_member.category_id, notes_member.notes,
      movement.occurred_at, visible.created_at, visible.revision
    FROM linked_decision decision
    INNER JOIN transactions visible
      ON visible.user_id = decision.user_id AND visible.id = decision.visible_transaction_id
    INNER JOIN transactions movement
      ON movement.user_id = decision.user_id
      AND movement.id = COALESCE(${correctedMember}, ${statementMember},
        decision.visible_transaction_id)
    INNER JOIN transactions category_member
      ON category_member.user_id = decision.user_id
      AND category_member.id = COALESCE(${decidedMember("category")}, decision.visible_transaction_id)
    INNER JOIN transactions counterparty_member
      ON counterparty_member.user_id = decision.user_id
      AND counterparty_member.id = COALESCE(${decidedMember("counterparty")},
        decision.visible_transaction_id)
    INNER JOIN transactions notes_member
      ON notes_member.user_id = decision.user_id
      AND notes_member.id = COALESCE(${decidedMember("notes")}, decision.visible_transaction_id)
  )`;

/** Build the `WITH` body naming the effective Transaction relation, plus its leading User bindings. */
export const effectiveTransactionRelation = (userId: string): EffectiveTransactionRelation => ({
  sql: `${linkedDecisionCte},${linkedMemberCte},${effectiveTransactionCte}`,
  bindings: [userId, userId],
});
