import { Effect, Option, Schema } from "effect";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import {
  IneligibleTransactionPair,
  TransactionNotFound,
  TransactionPairNotLinked,
} from "~/core/transactions/errors";
import { TransactionId, TransactionPairInput } from "~/core/transactions/model";
import {
  type LinkedTransactionDecision,
  type ReconciliationMember,
  type TransactionPair,
  decideEffectiveTransactionAuthorities,
  decideTransactionLink,
  orderTransactionPair,
} from "~/core/transactions/reconciliation";
import { TransactionUserDecisions } from "~/core/transactions/user-decisions";
import { UserId } from "~/core/identity/reference";
import { TransactionFlatRow, transactionColumns, transactionFromRow } from "./rows";

const ReconciliationMemberRow = Schema.Struct({
  ...TransactionFlatRow.fields,
  correctedAt: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  categoryUserDecided: TransactionUserDecisions.fields.category,
  counterpartyUserDecided: TransactionUserDecisions.fields.counterparty,
  notesUserDecided: TransactionUserDecisions.fields.notes,
  hasStatementSource: Schema.Boolean,
  alreadyLinked: Schema.Boolean,
});

const memberFromRow = Effect.fn(function* (row: typeof ReconciliationMemberRow.Type) {
  const transaction = yield* transactionFromRow(row);
  return {
    id: transaction.id,
    money: transaction.money,
    direction: transaction.direction,
    createdAt: transaction.createdAt,
    correctedAt: row.correctedAt,
    hasStatementSource: row.hasStatementSource,
    categoryUserDecided: row.categoryUserDecided,
    counterpartyUserDecided: row.counterpartyUserDecided,
    notesUserDecided: row.notesUserDecided,
  } satisfies ReconciliationMember;
});

const PairRequest = Schema.Struct({ userId: UserId, ...TransactionPairInput.fields });

const findMissingId = (
  pair: TransactionPair,
  rows: ReadonlyArray<typeof ReconciliationMemberRow.Type>
): TransactionId =>
  rows.some((row) => row.id === pair.firstTransactionId)
    ? pair.secondTransactionId
    : pair.firstTransactionId;

const lockPairMembers = Effect.fn(function* (
  userId: UserId,
  input: TransactionPairInput,
  allowLinked: boolean
) {
  const pair = yield* orderTransactionPair(input);
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* SqlSchema.findAll({
    Request: PairRequest,
    Result: ReconciliationMemberRow,
    execute: (request) => sql`
      SELECT ${sql.literal(transactionColumns)},
        transaction.facts_corrected_at AS "correctedAt",
        transaction.category_user_decided AS "categoryUserDecided",
        transaction.counterparty_user_decided AS "counterpartyUserDecided",
        transaction.notes_user_decided AS "notesUserDecided",
        EXISTS (
          SELECT 1 FROM source_attestations source
          WHERE source.transaction_id = transaction.id AND source.kind = 'statement-line'
        ) AS "hasStatementSource",
        EXISTS (
          SELECT 1 FROM transaction_reconciliation_members member
          WHERE member.user_id = transaction.user_id AND member.transaction_id = transaction.id
        ) AS "alreadyLinked"
      FROM transactions transaction
      WHERE transaction.user_id = ${request.userId}
        AND transaction.id IN (${request.firstTransactionId}, ${request.secondTransactionId})
        AND transaction.deleted_at IS NULL
      ORDER BY transaction.id
      FOR UPDATE
    `,
  })({ userId, ...pair }).pipe(Effect.orDie);

  if (rows.length !== 2) {
    return yield* new TransactionNotFound({ transactionId: findMissingId(pair, rows) });
  }
  if (!allowLinked && rows.some((row) => row.alreadyLinked)) {
    return yield* new IneligibleTransactionPair({ reason: "already-linked-member" });
  }
  const members = yield* Effect.forEach(rows, memberFromRow).pipe(Effect.orDie);
  const first = members[0];
  const second = members[1];
  if (first === undefined || second === undefined) {
    return yield* Effect.die("A locked reconciliation pair did not contain two members");
  }
  return { pair, first, second };
});

/** Validates and persists one reversible link inside the caller-owned User transaction. */
export const linkTransactionPairInScope = Effect.fn("linkTransactionPairInScope")(function* (
  userId: UserId,
  input: TransactionPairInput
) {
  const { first, second } = yield* lockPairMembers(userId, input, false);
  const decision = yield* decideTransactionLink(first, second);
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO transaction_reconciliation_decisions (
      user_id, first_transaction_id, second_transaction_id, state,
      visible_transaction_id, statement_transaction_id, movement_transaction_id,
      category_transaction_id, counterparty_transaction_id, notes_transaction_id, decided_at
    ) VALUES (
      ${userId}, ${decision.pair.firstTransactionId}, ${decision.pair.secondTransactionId},
      'linked', ${decision.visibleTransactionId},
      ${Option.getOrNull(decision.statementTransactionId)},
      ${decision.authorities.movementTransactionId},
      ${decision.authorities.categoryTransactionId},
      ${decision.authorities.counterpartyTransactionId},
      ${decision.authorities.notesTransactionId}, now()
    )
    ON CONFLICT (user_id, first_transaction_id, second_transaction_id) DO UPDATE SET
      state = 'linked', visible_transaction_id = EXCLUDED.visible_transaction_id,
      statement_transaction_id = EXCLUDED.statement_transaction_id,
      movement_transaction_id = EXCLUDED.movement_transaction_id,
      category_transaction_id = EXCLUDED.category_transaction_id,
      counterparty_transaction_id = EXCLUDED.counterparty_transaction_id,
      notes_transaction_id = EXCLUDED.notes_transaction_id, decided_at = now()
  `.pipe(Effect.orDie);
  yield* sql`
    INSERT INTO transaction_reconciliation_members (
      user_id, transaction_id, first_transaction_id, second_transaction_id
    ) VALUES
      (${userId}, ${decision.pair.firstTransactionId},
        ${decision.pair.firstTransactionId}, ${decision.pair.secondTransactionId}),
      (${userId}, ${decision.pair.secondTransactionId},
        ${decision.pair.firstTransactionId}, ${decision.pair.secondTransactionId})
  `.pipe(Effect.orDie);
  return decision;
});

const LinkedPairRow = TransactionPairInput;

/** Replaces one exact linked pair with keep-separate inside the caller-owned transaction. */
export const unlinkTransactionPairInScope = Effect.fn("unlinkTransactionPairInScope")(function* (
  userId: UserId,
  input: TransactionPairInput
) {
  const pair = yield* orderTransactionPair(input);
  const sql = yield* SqlClient.SqlClient;
  const linked = yield* SqlSchema.findOneOption({
    Request: PairRequest,
    Result: LinkedPairRow,
    execute: (request) => sql`
      SELECT first_transaction_id AS "firstTransactionId",
        second_transaction_id AS "secondTransactionId"
      FROM transaction_reconciliation_decisions
      WHERE user_id = ${request.userId}
        AND first_transaction_id = ${request.firstTransactionId}
        AND second_transaction_id = ${request.secondTransactionId}
        AND state = 'linked'
      FOR UPDATE
    `,
  })({ userId, ...pair }).pipe(Effect.orDie);
  if (Option.isNone(linked)) {
    return yield* new TransactionPairNotLinked(pair);
  }
  yield* sql`
    DELETE FROM transaction_reconciliation_members
    WHERE user_id = ${userId} AND first_transaction_id = ${pair.firstTransactionId}
      AND second_transaction_id = ${pair.secondTransactionId}
  `.pipe(Effect.orDie);
  yield* sql`
    UPDATE transaction_reconciliation_decisions
    SET state = 'keep-separate', visible_transaction_id = NULL,
      statement_transaction_id = NULL, movement_transaction_id = NULL,
      category_transaction_id = NULL, counterparty_transaction_id = NULL,
      notes_transaction_id = NULL, decided_at = now()
    WHERE user_id = ${userId} AND first_transaction_id = ${pair.firstTransactionId}
      AND second_transaction_id = ${pair.secondTransactionId}
  `.pipe(Effect.orDie);
  return pair;
});

/** Recomputes persisted authority ids after a correction under the User reconciliation lock. */
export const refreshLinkedTransactionAuthoritiesInScope = Effect.fn(
  "refreshLinkedTransactionAuthoritiesInScope"
)(function* (userId: UserId, transactionId: TransactionId) {
  const sql = yield* SqlClient.SqlClient;
  const pair = yield* SqlSchema.findOneOption({
    Request: Schema.Struct({ userId: UserId, transactionId: TransactionId }),
    Result: LinkedPairRow,
    execute: (request) => sql`
      SELECT first_transaction_id AS "firstTransactionId",
        second_transaction_id AS "secondTransactionId"
      FROM transaction_reconciliation_members
      WHERE user_id = ${request.userId} AND transaction_id = ${request.transactionId}
    `,
  })({ userId, transactionId }).pipe(Effect.orDie);
  if (Option.isNone(pair)) return;
  const { first, second } = yield* lockPairMembers(userId, pair.value, true).pipe(Effect.orDie);
  const authorities = decideEffectiveTransactionAuthorities({ first, second });
  yield* sql`
    UPDATE transaction_reconciliation_decisions
    SET movement_transaction_id = ${authorities.movementTransactionId},
      category_transaction_id = ${authorities.categoryTransactionId},
      counterparty_transaction_id = ${authorities.counterpartyTransactionId},
      notes_transaction_id = ${authorities.notesTransactionId}
    WHERE user_id = ${userId}
      AND first_transaction_id = ${pair.value.firstTransactionId}
      AND second_transaction_id = ${pair.value.secondTransactionId}
      AND state = 'linked'
  `.pipe(Effect.orDie);
});

/**
 * Soft-deletes one member after ending effective presentation, without rewriting the recorded
 * decision. The caller serializes deletion with linking and correction.
 */
export const deleteTransactionAndEndLinkInScope = Effect.fn("deleteTransactionAndEndLinkInScope")(
  function* (userId: UserId, transactionId: TransactionId) {
    const sql = yield* SqlClient.SqlClient;
    const locked = yield* SqlSchema.findOneOption({
      Request: Schema.Struct({ userId: UserId, transactionId: TransactionId }),
      Result: Schema.Struct({ id: TransactionId }),
      execute: (request) => sql`
      SELECT id FROM transactions
      WHERE user_id = ${request.userId} AND id = ${request.transactionId}
        AND deleted_at IS NULL
      FOR UPDATE
    `,
    })({ userId, transactionId }).pipe(Effect.orDie);
    if (Option.isNone(locked)) return Option.none<TransactionId>();

    const pair = yield* SqlSchema.findOneOption({
      Request: Schema.Struct({ userId: UserId, transactionId: TransactionId }),
      Result: LinkedPairRow,
      execute: (request) => sql`
      SELECT first_transaction_id AS "firstTransactionId",
        second_transaction_id AS "secondTransactionId"
      FROM transaction_reconciliation_members
      WHERE user_id = ${request.userId} AND transaction_id = ${request.transactionId}
      FOR UPDATE
    `,
    })({ userId, transactionId }).pipe(Effect.orDie);
    if (Option.isSome(pair)) {
      yield* sql`
      DELETE FROM transaction_reconciliation_members
      WHERE user_id = ${userId}
        AND first_transaction_id = ${pair.value.firstTransactionId}
        AND second_transaction_id = ${pair.value.secondTransactionId}
    `.pipe(Effect.orDie);
    }
    yield* sql`
    UPDATE transactions SET deleted_at = now()
    WHERE user_id = ${userId} AND id = ${transactionId}
  `.pipe(Effect.orDie);
    return Option.some(transactionId);
  }
);

export type { LinkedTransactionDecision };
