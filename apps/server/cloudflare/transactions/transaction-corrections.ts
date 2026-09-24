import {
  Transaction,
  TransactionId,
  UpdateTransactionInput,
  encodeMoneyAmount,
} from "@fidy/server/transactions-runtime";
import { recordAuditedPATUse, recordCanonicalPATWork } from "@fidy/server/tokens-runtime";
import { DateTime, Effect, Option, Schema } from "effect";
import { RequestBodyPolicy, readBoundedRequestBody } from "../http/request-body";
import { prepareOwnedStatement } from "../pats/pat-unit";
import {
  type TransactionBoundaryFailure,
  type TransactionCaller,
  boundaryFailure,
  callerAuthority,
  callerScope,
  invalidTransactionMessage,
  isPATCaller,
  liveTransactionAuthority,
  maximumTransactionInputBytes,
  missingTransactionMessage,
  transactionId,
  transactionNow,
  transactionUnavailable,
} from "./transaction-boundary";
import {
  type TransactionMutationPreparation,
  executeSingleTransactionMutation,
  failedPreparation,
  refusedPreparation,
  staleCorrectionMessage,
} from "./transaction-unit";
import { type StoredTransaction, TransactionOutput, findTransaction } from "./transaction-history";

const Input = Schema.toCodecJson(UpdateTransactionInput);
const Decisions = Schema.Record(Schema.String, Schema.Boolean);
const Fields = Schema.Array(Schema.String);
const policy = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: maximumTransactionInputBytes,
  deadlineMilliseconds: 2000,
});
type Correction = Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  id: string;
  input: typeof Input.Type;
}>;
type Change = Readonly<{
  correction: Correction;
  current: number;
  previous: StoredTransaction;
  updated: StoredTransaction;
}>;

/** Decode a bounded correction without treating omitted facts as explicit decisions. */
export const correctionInput = (request: Request): Promise<Option.Option<typeof Input.Type>> => {
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return Promise.resolve(Option.none());
  }
  return Effect.runPromise(readBoundedRequestBody(request, policy))
    .then((bytes) => {
      const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      return Schema.decodeUnknownOption(Input)(parsed);
    })
    .catch(() => Option.none());
};

const retain = <A>(value: Option.Option<A>, previous: A): A =>
  Option.getOrElse(value, () => previous);
const invalidCorrection = (input: typeof Input.Type, current: number): boolean =>
  Object.keys(input.changes).length === 0 ||
  (input.changes.occurredAt !== undefined &&
    DateTime.toEpochMillis(input.changes.occurredAt) > current);
const replaceFacts = (
  previous: StoredTransaction,
  changes: typeof Input.Type.changes
): Option.Option<StoredTransaction> =>
  Schema.decodeOption(Transaction)({
    id: previous.id,
    direction: retain(Option.fromUndefinedOr(changes.direction), previous.direction),
    categoryId: retain(Option.fromUndefinedOr(changes.categoryId), previous.categoryId),
    money: {
      amount: encodeMoneyAmount(
        retain(Option.fromUndefinedOr(changes.money?.amount), previous.money.amount)
      ),
      currency: retain(Option.fromUndefinedOr(changes.money?.currency), previous.money.currency),
    },
    occurredAt: DateTime.formatIso(
      retain(Option.fromUndefinedOr(changes.occurredAt), previous.occurredAt)
    ),
    createdAt: DateTime.formatIso(previous.createdAt),
    ...Option.match(
      Option.getOrElse(
        Option.map(Option.fromUndefinedOr(changes.counterparty), Option.fromNullishOr),
        () => previous.counterparty
      ),
      { onNone: () => ({}), onSome: (counterparty) => ({ counterparty }) }
    ),
    ...Option.match(
      Option.getOrElse(
        Option.map(Option.fromUndefinedOr(changes.notes), Option.fromNullishOr),
        () => previous.notes
      ),
      { onNone: () => ({}), onSome: (notes) => ({ notes }) }
    ),
    revision: previous.revision + 1,
  });

type Evidence = Readonly<{
  before: string;
  after: string;
  decisions: string;
  fields: string;
  id: string;
}>;
const changeStatements = (
  { correction, current, updated, previous }: Change,
  evidence: Evidence
): ReadonlyArray<D1PreparedStatement> => {
  const { db, subject, id, input } = correction;
  const authority = callerAuthority({ subject, current });
  return [
    db
      .prepare(`INSERT INTO transaction_corrections (id, user_id, transaction_id, previous_revision,
      changed_fields, before_facts, after_facts, corrected_at)
      SELECT ?, user_id, id, ?, ?, ?, ?, ? FROM transactions
      WHERE user_id = ? AND id = ? AND revision = ?
      AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
      .bind(
        evidence.id,
        previous.revision,
        evidence.fields,
        evidence.before,
        evidence.after,
        DateTime.formatIso(DateTime.makeUnsafe(current)),
        subject.userId,
        id,
        input.expectedRevision,
        ...authority.bindings
      ),
    db
      .prepare(`UPDATE transactions SET amount = ?, currency = ?, direction = ?, category_id = ?,
      counterparty = ?, notes = ?, occurred_at = ?, revision = revision + 1,
      user_decisions = json_patch(user_decisions, ?) WHERE user_id = ? AND id = ? AND revision = ?
      AND changes() = 1 AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
      .bind(
        encodeMoneyAmount(updated.money.amount),
        updated.money.currency,
        updated.direction,
        updated.categoryId,
        Option.getOrNull(updated.counterparty),
        Option.getOrNull(updated.notes),
        DateTime.formatIso(updated.occurredAt),
        evidence.decisions,
        subject.userId,
        id,
        input.expectedRevision,
        ...authority.bindings
      ),
  ];
};

const auditStatements = ({
  db,
  subject,
  current,
  correctionId,
  auditId,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  correctionId: string;
  auditId: string;
}>): ReadonlyArray<D1PreparedStatement> =>
  isPATCaller(subject)
    ? [
        prepareOwnedStatement({
          db,
          statement: recordCanonicalPATWork({
            subject,
            input: {
              id: auditId,
              current,
              operation: "transactions.updateTransaction",
              outcome: "accepted",
              afterSourceAttestation: true,
            },
          }),
        }),
        prepareOwnedStatement({
          db,
          statement: recordAuditedPATUse({
            subject,
            input: { auditId, current, operation: "transactions.updateTransaction" },
          }),
        }),
      ]
    : [
        db
          .prepare(`INSERT INTO transaction_audit (id, user_id, session_id, operation, outcome, occurred_at_ms)
        SELECT ?, user_id, ?, 'transactions.updateTransaction', 'success', ? FROM transaction_corrections
        WHERE id = ? AND user_id = ? AND changes() = 1`)
          .bind(transactionId(), subject.id, current, correctionId, subject.userId),
      ];

const emptyChangeMessage =
  "The correction must change at least one fact and cannot occur in the future.";

const findOwnedCorrection = ({
  db,
  subject,
  id,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  id: string;
}>): Effect.Effect<Option.Option<StoredTransaction>, TransactionBoundaryFailure> =>
  Effect.tryPromise({
    try: () => findTransaction({ db, userId: subject.userId, id }),
    catch: boundaryFailure,
  });

const correctionEvidence = (
  previous: StoredTransaction,
  updated: StoredTransaction,
  changes: typeof Input.Type.changes
): Effect.Effect<Evidence, Schema.SchemaError> =>
  Effect.gen(function* () {
    const fields = Object.keys(changes);
    return {
      before: yield* Schema.encodeEffect(Schema.fromJsonString(TransactionOutput))(previous),
      after: yield* Schema.encodeEffect(Schema.fromJsonString(TransactionOutput))(updated),
      decisions: yield* Schema.encodeEffect(Schema.fromJsonString(Decisions))(
        Object.fromEntries(fields.map((field) => [field, true]))
      ),
      fields: yield* Schema.encodeEffect(Schema.fromJsonString(Fields))(fields),
      id: transactionId(),
    };
  });

const preparedCorrection = ({
  correction,
  previous,
  updated,
  evidence,
}: Readonly<{
  correction: Correction & { current: number };
  previous: StoredTransaction;
  updated: StoredTransaction;
  evidence: Evidence;
}>): TransactionMutationPreparation => {
  const { db, subject, id, input, current } = correction;
  return {
    _tag: "Prepared",
    mutation: {
      operation: "transactions.updateTransaction",
      transactionId: id,
      expectedRevision: Option.some(input.expectedRevision),
      requiredScope: callerScope(subject),
      statements: [
        ...changeStatements({ correction, current, previous, updated }, evidence),
        ...auditStatements({
          db,
          subject,
          current,
          correctionId: evidence.id,
          auditId: transactionId(),
        }),
      ],
    },
  };
};

/**
 * Decide one canonical Transaction correction against live caller authority and the revision the
 * caller observed. The returned statements are guard-chained writes; the caller's D1 unit commits
 * them or none of them.
 */
export const prepareCorrection = (
  correction: Correction & { current: number }
): Effect.Effect<TransactionMutationPreparation> =>
  Effect.gen(function* () {
    const { db, subject, id, input, current } = correction;
    if (Option.isNone(Schema.decodeOption(TransactionId)(id))) {
      return refusedPreparation("not_found", missingTransactionMessage);
    }
    if (invalidCorrection(input, current)) {
      return refusedPreparation("validation_failed", emptyChangeMessage);
    }
    const live = yield* Effect.tryPromise({
      try: () => liveTransactionAuthority({ db, subject, current }),
      catch: boundaryFailure,
    });
    if (!live) return { _tag: "CredentialRefused" } as const;
    const owned = yield* findOwnedCorrection({ db, subject, id });
    if (Option.isNone(owned)) return refusedPreparation("not_found", missingTransactionMessage);
    if (owned.value.revision !== input.expectedRevision) {
      return refusedPreparation("validation_failed", staleCorrectionMessage);
    }
    const updated = replaceFacts(owned.value, input.changes);
    if (Option.isNone(updated)) {
      return refusedPreparation("validation_failed", invalidTransactionMessage);
    }
    const evidence = yield* correctionEvidence(owned.value, updated.value, input.changes);
    return preparedCorrection({
      correction,
      previous: owned.value,
      updated: updated.value,
      evidence,
    });
  }).pipe(Effect.orElseSucceed(failedPreparation));

/** Correct selected owned facts under live caller authority, retaining immutable evidence atomically. */
export const correctTransaction = (correction: Correction): Promise<Response> => {
  const current = transactionNow();
  return Effect.runPromise(
    Effect.gen(function* () {
      const preparation = yield* prepareCorrection({ ...correction, current });
      return yield* executeSingleTransactionMutation({
        db: correction.db,
        subject: correction.subject,
        current,
        operation: "transactions.updateTransaction",
        preparation,
        status: 200,
      });
    })
  ).catch(() => transactionUnavailable());
};
