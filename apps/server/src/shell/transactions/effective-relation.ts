import { type DateTime, Option } from "effect";
import type { SqlClient, Statement } from "effect/unstable/sql";
import type { UserId } from "~/core/identity/reference";

const authorityFact = (authorityColumn: string, column: string): string => `
  CASE decision.${authorityColumn}
    WHEN first_transaction.id THEN first_transaction.${column}
    WHEN second_transaction.id THEN second_transaction.${column}
    ELSE visible_transaction.${column}
  END`;

type EffectiveTransactionPeriod = Readonly<{
  from: DateTime.Utc;
  toExclusive: DateTime.Utc;
}>;

type EffectiveTransactionCteInput = Readonly<{
  sql: SqlClient.SqlClient;
  userId: UserId;
}>;

const periodConditions = (
  sql: SqlClient.SqlClient,
  period: Option.Option<EffectiveTransactionPeriod>,
  linkedOccurredAt: string
): Readonly<{ original: Statement.Fragment; linked: Statement.Fragment }> => ({
  original: Option.match(period, {
    onNone: () => sql`TRUE`,
    onSome: ({ from, toExclusive }) =>
      sql`original.occurred_at >= ${from} AND original.occurred_at < ${toExclusive}`,
  }),
  linked: Option.match(period, {
    onNone: () => sql`TRUE`,
    onSome: ({ from, toExclusive }) =>
      sql`${sql.literal(linkedOccurredAt)} >= ${from}
        AND ${sql.literal(linkedOccurredAt)} < ${toExclusive}`,
  }),
});

const activeReconciliationCte = (
  sql: SqlClient.SqlClient,
  userId: UserId
): Statement.Fragment => sql`
  active_transaction_reconciliation AS MATERIALIZED (
    SELECT decision.user_id, decision.first_transaction_id, decision.second_transaction_id,
      decision.visible_transaction_id, decision.movement_transaction_id,
      decision.category_transaction_id, decision.counterparty_transaction_id,
      decision.notes_transaction_id
    FROM transaction_reconciliation_decisions decision
    INNER JOIN transaction_reconciliation_members visible_member
      ON visible_member.user_id = decision.user_id
      AND visible_member.first_transaction_id = decision.first_transaction_id
      AND visible_member.second_transaction_id = decision.second_transaction_id
      AND visible_member.transaction_id = decision.visible_transaction_id
    WHERE decision.user_id = ${userId} AND decision.state = 'linked'
  )
`;

const makeEffectiveTransactionCte = ({
  sql,
  userId,
  period,
}: EffectiveTransactionCteInput &
  Readonly<{ period: Option.Option<EffectiveTransactionPeriod> }>): Statement.Fragment => {
  const amount = authorityFact("movement_transaction_id", "amount");
  const currency = authorityFact("movement_transaction_id", "currency");
  const occurredAt = authorityFact("movement_transaction_id", "occurred_at");
  const direction = authorityFact("movement_transaction_id", "direction");
  const category = authorityFact("category_transaction_id", "category_id");
  const counterparty = authorityFact("counterparty_transaction_id", "counterparty");
  const notes = authorityFact("notes_transaction_id", "notes");
  const periodCondition = periodConditions(sql, period, occurredAt);

  return sql`
    ${activeReconciliationCte(sql, userId)},
    effective_transaction AS (
      SELECT original.user_id, original.id, original.amount, original.currency,
        original.counterparty, original.direction, original.category_id, original.notes,
        original.occurred_at, original.created_at, original.deleted_at
      FROM transactions original
      WHERE original.user_id = ${userId} AND original.deleted_at IS NULL
        AND ${periodCondition.original}
        AND NOT EXISTS (
          SELECT 1 FROM transaction_reconciliation_members member
          WHERE member.user_id = original.user_id AND member.transaction_id = original.id
        )

      UNION ALL

      SELECT visible_transaction.user_id, visible_transaction.id,
        ${sql.literal(amount)} AS amount,
        ${sql.literal(currency)} AS currency,
        ${sql.literal(counterparty)} AS counterparty,
        ${sql.literal(direction)} AS direction,
        ${sql.literal(category)} AS category_id,
        ${sql.literal(notes)} AS notes,
        ${sql.literal(occurredAt)} AS occurred_at,
        visible_transaction.created_at, visible_transaction.deleted_at
      FROM active_transaction_reconciliation decision
      INNER JOIN transactions visible_transaction
        ON visible_transaction.user_id = decision.user_id
        AND visible_transaction.id = decision.visible_transaction_id
      INNER JOIN transactions first_transaction
        ON first_transaction.user_id = decision.user_id
        AND first_transaction.id = decision.first_transaction_id
      INNER JOIN transactions second_transaction
        ON second_transaction.user_id = decision.user_id
        AND second_transaction.id = decision.second_transaction_id
      WHERE visible_transaction.deleted_at IS NULL AND ${periodCondition.linked}
    )
  `;
};

/** Projects every active original or linked purchase into one effective Transaction relation. */
export const effectiveTransactionCte = (input: EffectiveTransactionCteInput): Statement.Fragment =>
  makeEffectiveTransactionCte({ ...input, period: Option.none() });

/** Projects the effective relation inside one half-open Transaction occurrence period. */
export const effectiveTransactionPeriodCte = (
  input: EffectiveTransactionCteInput & EffectiveTransactionPeriod
): Statement.Fragment =>
  makeEffectiveTransactionCte({
    sql: input.sql,
    userId: input.userId,
    period: Option.some({ from: input.from, toExclusive: input.toExclusive }),
  });
