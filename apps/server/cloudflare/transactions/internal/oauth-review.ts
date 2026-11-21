import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Effect, Option, Schema } from "effect";
import { Currency } from "../../../src/core/_shared/money";
import { Direction, TransactionId } from "../../../src/core/transactions/contract";
import { type TransactionBoundaryFailure, boundaryFailure } from "../../canonical-work/operations";
import {
  type StoredTransaction,
  TransactionOutput,
  decodeTransactionRow,
} from "./transaction-history";
import { ReconciliationDecisionRow } from "./reconciliation-state";

const FactRow = Schema.Struct({
  id: TransactionId,
  amount: Schema.String,
  currency: Currency,
  direction: Direction,
  counterparty: Schema.NullOr(Schema.String),
  category_id: Schema.String,
  notes: Schema.NullOr(Schema.String),
  occurred_at: Schema.String,
  created_at: Schema.String,
  revision: Schema.Int,
});

const Snapshot = Schema.Struct({
  retained: Schema.Array(
    Schema.Struct({
      ...FactRow.fields,
      user_decisions: Schema.fromJsonString(Schema.Record(Schema.String, Schema.Boolean)),
      corrected_at: Schema.NullOr(Schema.String),
      statement_source: Schema.Literals([0, 1]),
    })
  ),
  effective: Schema.Array(FactRow),
  decisions: Schema.Array(
    Schema.Struct({
      ...ReconciliationDecisionRow.fields,
      first_transaction_id: TransactionId,
      second_transaction_id: TransactionId,
      visible_transaction_id: Schema.NullOr(TransactionId),
      decided_at: Schema.String,
    })
  ),
  members: Schema.Array(
    Schema.Struct({
      transaction_id: TransactionId,
      first_transaction_id: TransactionId,
      second_transaction_id: TransactionId,
    })
  ),
});

const SnapshotRow = Schema.Struct({ snapshot: Schema.fromJsonString(Snapshot) });

const snapshotBody = `selected(id) AS (SELECT id FROM roots UNION
    SELECT first_transaction_id FROM decisions WHERE state = 'linked' UNION
    SELECT second_transaction_id FROM decisions WHERE state = 'linked')
  SELECT json_object(
    'retained', json((SELECT json_group_array(json_object(
      'id', id, 'amount', amount, 'currency', currency, 'direction', direction,
      'counterparty', counterparty, 'category_id', category_id, 'notes', notes,
      'occurred_at', occurred_at, 'created_at', created_at, 'revision', revision,
      'user_decisions', user_decisions,
      'corrected_at', strftime('%Y-%m-%dT%H:%M:%fZ',(SELECT MAX(corrected_at_ms) FROM transaction_corrections correction
        WHERE correction.user_id = retained.user_id AND correction.transaction_id = retained.id)/1000.0,'unixepoch'),
      'statement_source', EXISTS (SELECT 1 FROM source_attestations source
        WHERE source.user_id = retained.user_id AND source.transaction_id = retained.id
          AND source.kind = 'statement-line')))
      FROM (SELECT *, strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at_ms/1000.0,'unixepoch') AS occurred_at, strftime('%Y-%m-%dT%H:%M:%fZ',created_at_ms/1000.0,'unixepoch') AS created_at FROM transactions WHERE user_id = ? AND deleted_at_ms IS NULL AND id IN selected ORDER BY id) retained)),
    'effective', json((SELECT json_group_array(json_object(
      'id', id, 'amount', amount, 'currency', currency, 'direction', direction,
      'counterparty', counterparty, 'category_id', category_id, 'notes', notes,
      'occurred_at', occurred_at, 'created_at', created_at, 'revision', revision))
      FROM (SELECT * FROM transaction_effective_source
        WHERE user_id = ? AND id IN selected ORDER BY id))),
    'decisions', json((SELECT json_group_array(json_object(
      'first_transaction_id', first_transaction_id, 'second_transaction_id', second_transaction_id,
      'state', state, 'visible_transaction_id', visible_transaction_id, 'decided_at', strftime('%Y-%m-%dT%H:%M:%fZ',decided_at_ms/1000.0,'unixepoch')))
      FROM (SELECT * FROM decisions ORDER BY first_transaction_id, second_transaction_id))),
    'members', json((SELECT json_group_array(json_object(
      'transaction_id', transaction_id, 'first_transaction_id', first_transaction_id,
      'second_transaction_id', second_transaction_id))
      FROM (SELECT * FROM reconciled_transactions
        WHERE user_id = ? AND transaction_id IN selected ORDER BY transaction_id)))
  ) AS snapshot`;

const snapshotSql = `WITH roots(id) AS (SELECT ? UNION SELECT ?),
  decisions AS (SELECT * FROM transaction_reconciliation_decisions
    WHERE user_id = ? AND ((state = 'linked' AND
      (first_transaction_id IN roots OR second_transaction_id IN roots)) OR
      (first_transaction_id = ? AND second_transaction_id = ?))),
  ${snapshotBody}`;

const decodeFacts = (
  rows: ReadonlyArray<typeof FactRow.Type>
): Effect.Effect<ReadonlyArray<StoredTransaction>, TransactionBoundaryFailure> =>
  Effect.forEach(rows, (row) =>
    Effect.fromOption(decodeTransactionRow(row), () =>
      boundaryFailure("invalid_transaction_snapshot")
    )
  );

export const discloseTransactions = (
  transactions: ReadonlyArray<typeof TransactionOutput.Type>
): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Array(TransactionOutput)))(transactions);

export const localCorrectionReview = Effect.fn(function* (
  user: string,
  id: string,
  after: Option.Option<string>
) {
  const sql = yield* SqliteClient;
  const [row] = yield* sql.unsafe(snapshotSql, [id, id, user, id, id, user, user, user]);
  const { snapshot } = yield* Schema.decodeUnknownEffect(SnapshotRow)(row);

  const original = discloseTransactions(yield* decodeFacts(snapshot.retained)),
    effective = discloseTransactions(yield* decodeFacts(snapshot.effective));

  const revision = yield* Schema.encodeEffect(Schema.fromJsonString(Snapshot))(snapshot);

  return {
    revision,
    effect: Option.match(after, {
      onNone: () =>
        `Eliminar permanentemente la Transacción ${id}: ${original}. No se puede restaurar; se conservan las SourceAttestations.`,
      onSome: (value) =>
        `Corregir la Transacción original ${id}. Hechos originales antes: ${original}. Hechos después: ${value}. Transacciones efectivas actuales: ${effective}. Se conserva la Reconciliación y se recalculan los hechos efectivos.`,
    }),
  };
});
