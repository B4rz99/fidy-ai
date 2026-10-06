import { Effect, Option, Schema } from "effect";
import { Currency } from "../../../src/core/_shared/money";
import { Direction, TransactionId } from "../../../src/core/transactions/contract";
import { type TransactionBoundaryFailure, boundaryFailure } from "../../canonical-work/operations";
import type { OAuthMutationReview } from "../../oauth-confirmation/contract";
import { oauthMutationReview } from "../../oauth-confirmation/operations";
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

// One read and the exact same fixed SQL at commit bind all effective-policy inputs, including
// absence of a link, the addressed original revision, correction rank and statement-source rank.
const snapshotSql = `WITH roots(id) AS (SELECT ? UNION SELECT ?),
  decisions AS (SELECT * FROM transaction_reconciliation_decisions
    WHERE user_id = ? AND ((state = 'linked' AND
      (first_transaction_id IN roots OR second_transaction_id IN roots)) OR
      (first_transaction_id = ? AND second_transaction_id = ?))),
  selected(id) AS (SELECT id FROM roots UNION
    SELECT first_transaction_id FROM decisions WHERE state = 'linked' UNION
    SELECT second_transaction_id FROM decisions WHERE state = 'linked')
  SELECT json_object(
    'retained', json((SELECT json_group_array(json_object(
      'id', id, 'amount', amount, 'currency', currency, 'direction', direction,
      'counterparty', counterparty, 'category_id', category_id, 'notes', notes,
      'occurred_at', occurred_at, 'created_at', created_at, 'revision', revision,
      'user_decisions', user_decisions,
      'corrected_at', (SELECT MAX(corrected_at) FROM transaction_corrections correction
        WHERE correction.user_id = retained.user_id AND correction.transaction_id = retained.id),
      'statement_source', EXISTS (SELECT 1 FROM source_attestations source
        WHERE source.user_id = retained.user_id AND source.transaction_id = retained.id
          AND source.kind = 'statement-line')))
      FROM (SELECT * FROM transactions WHERE user_id = ? AND id IN selected ORDER BY id) retained)),
    'effective', json((SELECT json_group_array(json_object(
      'id', id, 'amount', amount, 'currency', currency, 'direction', direction,
      'counterparty', counterparty, 'category_id', category_id, 'notes', notes,
      'occurred_at', occurred_at, 'created_at', created_at, 'revision', revision))
      FROM (SELECT * FROM dashboard_effective_source
        WHERE user_id = ? AND id IN selected ORDER BY id))),
    'decisions', json((SELECT json_group_array(json_object(
      'first_transaction_id', first_transaction_id, 'second_transaction_id', second_transaction_id,
      'state', state, 'visible_transaction_id', visible_transaction_id, 'decided_at', decided_at))
      FROM (SELECT * FROM decisions ORDER BY first_transaction_id, second_transaction_id))),
    'members', json((SELECT json_group_array(json_object(
      'transaction_id', transaction_id, 'first_transaction_id', first_transaction_id,
      'second_transaction_id', second_transaction_id))
      FROM (SELECT * FROM transaction_reconciliation_members
        WHERE user_id = ? AND transaction_id IN selected ORDER BY transaction_id)))
  ) AS snapshot`;

export type ObservedTransactions = Readonly<{
  retained: ReadonlyArray<StoredTransaction>;
  effective: ReadonlyArray<StoredTransaction>;
  decisions: typeof Snapshot.Type.decisions;
  members: typeof Snapshot.Type.members;
  review: (effect: string) => Option.Option<OAuthMutationReview>;
}>;

const decodeFacts = (
  rows: ReadonlyArray<typeof FactRow.Type>
): Effect.Effect<ReadonlyArray<StoredTransaction>, TransactionBoundaryFailure> =>
  Effect.forEach(rows, (row) =>
    Effect.fromOption(decodeTransactionRow(row), () =>
      boundaryFailure("invalid_transaction_snapshot")
    )
  );

/** Read a bounded pair and every retained premise used to select its effective facts. */
export const observeOAuthTransactions = (
  input: Readonly<{
    db: D1Database;
    userId: string;
    firstId: string;
    secondId: string;
  }>
): Effect.Effect<ObservedTransactions, TransactionBoundaryFailure | Schema.SchemaError> =>
  Effect.gen(function* () {
    const params = [
      input.firstId,
      input.secondId,
      input.userId,
      input.firstId,
      input.secondId,
      input.userId,
      input.userId,
      input.userId,
    ];
    const raw = yield* Effect.tryPromise({
      try: () =>
        input.db
          .prepare(snapshotSql)
          .bind(...params)
          .first(),
      catch: boundaryFailure,
    });
    const { snapshot } = yield* Schema.decodeUnknownEffect(SnapshotRow)(raw);
    const retained = yield* decodeFacts(snapshot.retained);
    const effective = yield* decodeFacts(snapshot.effective);
    // Preserve the SQL JSON bytes rather than re-encoding: the guard compares this same projection.
    const encoded = yield* Schema.decodeUnknownEffect(Schema.Struct({ snapshot: Schema.String }))(
      raw
    );
    return {
      retained,
      effective,
      decisions: snapshot.decisions,
      members: snapshot.members,
      review: (effect: string): Option.Option<OAuthMutationReview> =>
        Option.some(
          oauthMutationReview({
            db: input.db,
            effect,
            revision: encoded.snapshot,
            guard: {
              sql: `SELECT 1 FROM (${snapshotSql}) WHERE snapshot = ?`,
              params: [...params, encoded.snapshot],
            },
          })
        ),
    };
  });

/** Exact Spanish financial disclosure, using the same canonical Money encoding as native reads. */
export const discloseTransactions = (
  transactions: ReadonlyArray<typeof TransactionOutput.Type>
): string =>
  Schema.encodeSync(Schema.fromJsonString(Schema.Array(TransactionOutput)))(transactions);
