import { Array, type Cause, DateTime, Effect, Option, Schema } from "effect";
import {
  UpdateTransactionsInput,
  UpdateTransactionsResult,
} from "../../../src/shell/transactions/contract";
import { preparePredicateAssertion } from "../../../src/shell/sql-assertions/operations";
import { encodeMoneyAmount } from "../../../src/core/_shared/money";
import type {
  CanonicalMutationPreparation,
  CommittedMutationValue,
} from "../../canonical-operations/contract";
import {
  type CanonicalCaller,
  type TransactionBoundaryFailure,
  boundaryFailure,
  callerAuthority,
  callerScope,
  credentialRefusedPreparation,
  failedPreparation,
  isOAuthCaller,
  liveTransactionAuthority,
} from "../../canonical-work/operations";
import { type ObservedTransactions, discloseTransactions, observeOAuthGroup } from "./oauth-review";
import {
  auditStatements,
  correctionEvidence,
  invalidCorrection,
  replaceFacts,
} from "./transaction-corrections";
import { type StoredTransaction, decodeTransactionRow } from "./transaction-history";
import {
  refusedTransactionMutation,
  staleCorrectionMessage,
  transactionRefusal,
} from "./transaction-outcome";

type Work = Readonly<{
  db: D1Database;
  subject: CanonicalCaller;
  current: number;
  input: typeof UpdateTransactionsInput.Type;
}>;
const operation = "transactions.updateTransactions";
const assertion = (db: D1Database, count: number): D1PreparedStatement =>
  preparePredicateAssertion({
    db,
    scope: "transaction_fact",
    predicate: {
      sql: "SELECT 1 WHERE changes() = ?",
      params: [count],
    },
  });

const selectedRows = (
  work: Work
): Effect.Effect<ReadonlyArray<unknown>, TransactionBoundaryFailure> =>
  Effect.tryPromise({
    try: () =>
      work.db
        .prepare(`SELECT id, amount, currency, direction,
    counterparty, category_id, notes, revision,
    strftime('%Y-%m-%dT%H:%M:%fZ',occurred_at_ms/1000.0,'unixepoch') AS occurred_at,
    strftime('%Y-%m-%dT%H:%M:%fZ',created_at_ms/1000.0,'unixepoch') AS created_at
    FROM transactions WHERE user_id = ? AND deleted_at_ms IS NULL
      AND id IN (SELECT json_extract(value, '$.id') FROM json_each(?))
    ORDER BY id`)
        .bind(work.subject.userId, encodeTargets(work.input.transactions))
        .all(),
    catch: boundaryFailure,
  }).pipe(Effect.map((result) => result.results));

const PreparedRow = Schema.Struct({
  id: Schema.String,
  revision: Schema.Int,
  correctionId: Schema.String,
  before: Schema.String,
  after: Schema.String,
  amount: Schema.String,
  currency: Schema.String,
  direction: Schema.String,
  categoryId: Schema.String,
  counterparty: Schema.NullOr(Schema.String),
  notes: Schema.NullOr(Schema.String),
  occurredAt: Schema.Int,
});
type PreparedRows = Array.NonEmptyReadonlyArray<typeof PreparedRow.Type>;
const encodeRows = Schema.encodeSync(Schema.fromJsonString(Schema.Array(PreparedRow)));
const encodeTargets = Schema.encodeSync(
  Schema.fromJsonString(UpdateTransactionsInput.fields.transactions)
);
const encodeStrings = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const encodeDecisions = Schema.encodeSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Boolean))
);

const groupStatements = (work: Work, rows: PreparedRows): ReadonlyArray<D1PreparedStatement> => {
  const { db, subject, current } = work;
  const authority = callerAuthority({ subject, current });
  const encoded = encodeRows(rows);
  const fields = Object.keys(work.input.changes);
  const decisions = encodeDecisions(Object.fromEntries(fields.map((field) => [field, true])));
  return [
    db
      .prepare(`INSERT INTO transaction_corrections
      (id,user_id,transaction_id,previous_revision,changed_fields,before_facts,after_facts,corrected_at_ms)
      SELECT json_extract(item.value,'$.correctionId'), original.user_id, original.id,
        original.revision, ?, json_extract(item.value,'$.before'), json_extract(item.value,'$.after'), ?
      FROM json_each(?) item JOIN transactions original
        ON original.id = json_extract(item.value,'$.id')
      WHERE original.user_id = ? AND original.deleted_at_ms IS NULL
        AND original.revision = json_extract(item.value,'$.revision')
        AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
      .bind(encodeStrings(fields), current, encoded, subject.userId, ...authority.bindings),
    assertion(db, rows.length),
    db
      .prepare(`UPDATE transactions SET
      amount = json_extract(item.value,'$.amount'), currency = json_extract(item.value,'$.currency'),
      direction = json_extract(item.value,'$.direction'), category_id = json_extract(item.value,'$.categoryId'),
      counterparty = json_extract(item.value,'$.counterparty'), notes = json_extract(item.value,'$.notes'),
      occurred_at_ms = json_extract(item.value,'$.occurredAt'), revision = revision + 1,
      user_decisions = json_patch(user_decisions, ?)
      FROM json_each(?) item
      WHERE transactions.user_id = ? AND transactions.id = json_extract(item.value,'$.id') AND transactions.deleted_at_ms IS NULL
        AND transactions.revision = json_extract(item.value,'$.revision')
        AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
      .bind(decisions, encoded, subject.userId, ...authority.bindings),
    assertion(db, rows.length),
    ...auditStatements({
      db,
      subject,
      current,
      correctionId: rows[0].correctionId,
      operation,
    }),
  ];
};

const committedGroup = (
  work: Work,
  rows: PreparedRows
): Effect.Effect<Option.Option<CommittedMutationValue>> =>
  Effect.tryPromise(() =>
    work.db
      .prepare(`SELECT count(*) AS count FROM transaction_corrections
    WHERE user_id = ? AND id IN (SELECT json_extract(value,'$.correctionId') FROM json_each(?))`)
      .bind(work.subject.userId, encodeRows(rows))
      .first()
  ).pipe(
    Effect.map((raw): Option.Option<CommittedMutationValue> => {
      const result = Schema.decodeUnknownOption(Schema.Struct({ count: Schema.Int }))(raw);
      if (Option.isNone(result) || result.value.count !== rows.length) return Option.none();
      const payload = { updated: rows.length };
      return Option.some({
        _tag: "Owner",
        payload,
        encode: () => Schema.encodeEffect(UpdateTransactionsResult)(payload),
      });
    }),
    Effect.orElseSucceed(() => Option.none())
  );

const groupRows = (
  work: Work,
  records: ReadonlyArray<StoredTransaction>,
  updated: ReadonlyArray<StoredTransaction>
): Effect.Effect<PreparedRows, Schema.SchemaError> =>
  Effect.forEach(updated, (record, index) =>
    Effect.gen(function* () {
      const previous = records[index];
      if (previous === undefined) return yield* Effect.die("Missing selected Transaction");
      const evidence = yield* correctionEvidence({
        previous,
        updated: record,
        changes: work.input.changes,
      });
      return {
        id: previous.id,
        revision: previous.revision,
        correctionId: evidence.id,
        before: evidence.before,
        after: evidence.after,
        amount: encodeMoneyAmount(record.money.amount),
        currency: record.money.currency,
        direction: record.direction,
        categoryId: record.categoryId,
        counterparty: Option.getOrNull(record.counterparty),
        notes: Option.getOrNull(record.notes),
        occurredAt: DateTime.toEpochMillis(record.occurredAt),
      };
    })
  ).pipe(
    Effect.filterOrElse(Array.isArrayNonEmpty, () => Effect.die("Missing selected Transactions"))
  );

const preparedGroup = (
  work: Work,
  rows: PreparedRows,
  observed: Option.Option<ObservedTransactions>
): CanonicalMutationPreparation => {
  const { subject } = work;
  return {
    _tag: "Prepared",
    mutation: {
      requiredScope: callerScope(subject),
      oauthReview: Option.flatMap(observed, (snapshot) =>
        snapshot.review(
          `Corregir las Transacciones originales seleccionadas. Hechos originales del conjunto antes: ${discloseTransactions(snapshot.retained)}. Hechos seleccionados después: ${encodeStrings(rows.map((row) => row.after))}. Transacciones efectivas actuales: ${discloseTransactions(snapshot.effective)}. Se conserva la Reconciliación; los hechos efectivos se recalculan con la política de Transacciones.`
        )
      ),
      commitGuards: Option.none(),
      statements: groupStatements(work, rows),
      guardRefusal: (guard) =>
        Effect.succeed(
          transactionRefusal({
            ...guard,
            operation,
            refusal: { outcome: "validation_failed", message: staleCorrectionMessage },
          })
        ),
      outcome: {
        _tag: "Owner",
        operation,
        collisionKey: Option.none(),
        guardFacts: Option.none(),
        read: () => committedGroup(work, rows),
      },
    },
  };
};

/** Correct the exact selection in one guarded commit; absent or stale members change no records. */
export const prepareGroupCorrection = (work: Work): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* (): Effect.fn.Return<
    CanonicalMutationPreparation,
    TransactionBoundaryFailure | Schema.SchemaError | Cause.UnknownError
  > {
    const { db, subject, current, input } = work;
    const refuse = (
      outcome: "validation_failed" | "not_found",
      message: string
    ): CanonicalMutationPreparation =>
      refusedTransactionMutation({
        db,
        subject,
        current,
        operation,
        refusal: { outcome, message },
      });
    if (invalidCorrection({ input: { expectedRevision: 0, changes: input.changes }, current })) {
      return refuse(
        "validation_failed",
        "The correction must change at least one fact and cannot occur in the future."
      );
    }
    const live = yield* Effect.tryPromise(() => liveTransactionAuthority({ db, subject, current }));
    if (!live) return credentialRefusedPreparation();
    const observed = isOAuthCaller(subject)
      ? Option.some(
          yield* observeOAuthGroup({ db, userId: subject.userId, transactions: input.transactions })
        )
      : Option.none();
    const raw = yield* selectedRows(work);
    const records = Option.all(raw.map(decodeTransactionRow));
    if (Option.isNone(records)) return failedPreparation();
    if (records.value.length !== input.transactions.length) {
      return refuse("not_found", "Transaction unavailable.");
    }
    const revisions = new Map(
      input.transactions.map((record) => [record.id, record.expectedRevision])
    );
    if (records.value.some((record) => revisions.get(record.id) !== record.revision)) {
      return refuse("validation_failed", staleCorrectionMessage);
    }
    const updated = Option.all(
      records.value.map((record) => replaceFacts({ previous: record, changes: input.changes }))
    );
    if (Option.isNone(updated)) return refuse("validation_failed", "Invalid Transaction input.");
    const rows = yield* groupRows(work, records.value, updated.value);
    return preparedGroup(work, rows, observed);
  }).pipe(Effect.orElseSucceed(failedPreparation));
