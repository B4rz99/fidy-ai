import { TransactionId } from "../../../src/core/transactions/contract";
import type { TransactionOutcome } from "../contract";
import { Effect, Option, Schema } from "effect";
import type {
  TransactionPair,
  TransactionPresentation,
} from "../../../src/core/transactions/contract";
import {
  type CanonicalMutationPreparation,
  type CanonicalMutationRefusal,
  type CommittedMutationValue,
  type GuardRefusalWork,
} from "../../canonical-operations/contract";
import {
  type CanonicalCaller,
  type TransactionMutationOperation,
  type TransactionRefusal,
  alreadyLinkedMessage,
  missingTransactionMessage,
  pairPolicyMessage,
  recordTransactionRefusal,
  refusalFailureCode,
  refusedCredentialResponse,
  refusedPreparation,
  refusedTransactionResponse,
  transactionUnavailable,
  unlinkedPairMessage,
} from "../../canonical-work/operations";

import { ReconciliationDecisionRow } from "./reconciliation-state";
import {
  type StoredTransaction,
  findTransaction,
  findTransactionPair,
  findTransactionPresentation,
} from "./transaction-history";

export const staleCorrectionMessage =
  "The Transaction changed since it was read. Re-read it and retry the correction.";

const staleCorrectionRefusal: TransactionRefusal = {
  outcome: "validation_failed",
  message: staleCorrectionMessage,
};

export const transactionGuardRefusal =
  (outcome: TransactionOutcome) =>
  ({
    db,
    subject,
    current,
    earlier,
  }: GuardRefusalWork): Effect.Effect<CanonicalMutationRefusal> => {
    const operation = outcome.operation;
    const generic = transactionRefusal({
      db,
      subject,
      current,
      operation,
      refusal: {
        outcome: "validation_failed",
        message: "The Transaction could not complete its guarded write.",
      },
    });
    const expected = outcome.expectedRevision;
    const repeated =
      Option.isSome(expected) &&
      earlier.some(
        (previous) =>
          previous._tag === "Transaction" &&
          previous.transactionId === outcome.transactionId &&
          Option.isSome(previous.expectedRevision) &&
          previous.expectedRevision.value === expected.value
      );
    return transactionAbortRefusal({ db, userId: subject.userId, outcome, repeated }).pipe(
      Effect.map(
        Option.match({
          onNone: () => generic,
          onSome: (refusal) => transactionRefusal({ db, subject, current, operation, refusal }),
        })
      )
    );
  };

export const transactionRefusal = ({
  db,
  subject,
  operation,
  refusal,
  current,
}: Readonly<{
  db: D1Database;
  subject: CanonicalCaller;
  operation: TransactionMutationOperation;
  refusal: TransactionRefusal;
  current: number;
}>): CanonicalMutationRefusal => ({
  code: refusalFailureCode(refusal.outcome),
  message: refusal.message,
  record: () =>
    Effect.tryPromise(() =>
      recordTransactionRefusal({
        db,
        subject,
        outcome: refusal.outcome,
        operation,
        current,
      })
    ).pipe(Effect.orElseSucceed(() => "unavailable" as const)),
  respond: (disposition) => {
    switch (disposition) {
      case "recorded":
        return Effect.succeed(refusedTransactionResponse(refusal));
      case "credential_refused":
        return refusedCredentialResponse({ db, subject });

      case "unavailable":
        return Effect.succeed(transactionUnavailable());
    }
  },
});

export const refusedTransactionMutation = ({
  db,
  subject,
  operation,
  refusal,
  current,
}: Readonly<{
  db: D1Database;
  subject: CanonicalCaller;
  operation: TransactionMutationOperation;
  refusal: TransactionRefusal;
  current: number;
}>): CanonicalMutationPreparation =>
  refusedPreparation(transactionRefusal({ db, subject, operation, refusal, current }));

const findDeletedTransactionValue = ({
  db,
  userId,
  outcome,
}: Readonly<{ db: D1Database; userId: string; outcome: TransactionOutcome }>): Effect.Effect<
  Option.Option<CommittedMutationValue>
> =>
  Effect.gen(function* () {
    const row = yield* Effect.tryPromise(() =>
      db
        .prepare(
          "SELECT id FROM transactions WHERE user_id = ? AND id = ? AND deleted_at_ms IS NOT NULL"
        )
        .bind(userId, outcome.transactionId)
        .first()
    ).pipe(Effect.orElseSucceed(() => null));
    return Option.map(
      Schema.decodeUnknownOption(Schema.Struct({ id: TransactionId }))(row),
      ({ id }) => ({
        _tag: "Owner" as const,
        payload: id,
        encode: () => Schema.encodeEffect(Schema.toCodecJson(TransactionId))(id),
      })
    );
  });

export const findTransactionValue = ({
  db,
  userId,
  outcome,
}: Readonly<{
  db: D1Database;
  userId: string;
  outcome: TransactionOutcome;
}>): Effect.Effect<Option.Option<CommittedMutationValue>> =>
  Effect.gen(function* () {
    if (outcome.readback._tag === "DeletedTransaction") {
      return yield* findDeletedTransactionValue({ db, userId, outcome });
    }
    if (outcome.readback._tag === "Transaction") {
      const found = yield* Effect.tryPromise(() =>
        findTransaction({ db, userId, id: outcome.transactionId })
      ).pipe(Effect.orElseSucceed(() => Option.none<StoredTransaction>()));
      return Option.map(found, (transaction) => ({ _tag: "Transaction" as const, transaction }));
    }
    if (outcome.readback._tag === "EffectiveTransaction") {
      const presentation = yield* Effect.tryPromise(() =>
        findTransactionPresentation({ db, userId, id: outcome.transactionId })
      ).pipe(Effect.orElseSucceed(() => Option.none<TransactionPresentation>()));
      return Option.map(presentation, (transaction) => ({
        _tag: "EffectiveTransaction" as const,
        transaction,
      }));
    }
    const pair = outcome.readback.pair;
    const records = yield* Effect.tryPromise(() =>
      findTransactionPair({ db, userId, ids: [pair.firstTransactionId, pair.secondTransactionId] })
    ).pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(records)) return Option.none<CommittedMutationValue>();
    const [first, second] = records.value;
    return Option.some({
      _tag: "RestoredPair" as const,
      pair: {
        firstTransaction: { ...first, presentation: { kind: "independent" } },
        secondTransaction: { ...second, presentation: { kind: "independent" } },
      },
    });
  });

const PairPremiseRow = Schema.Struct({
  member_total: Schema.Int,
  row_total: Schema.Int,
  eligible: Schema.Int,
});

const linkPremiseRefusalFor = (
  premise: typeof PairPremiseRow.Type
): Option.Option<TransactionRefusal> => {
  if (premise.member_total > 0) {
    return Option.some({ outcome: "validation_failed", message: alreadyLinkedMessage });
  }
  if (premise.row_total < 2) {
    return Option.some({ outcome: "not_found", message: missingTransactionMessage });
  }
  return premise.eligible === 0
    ? Option.some({ outcome: "validation_failed", message: pairPolicyMessage })
    : Option.none();
};

const linkPremiseRefusal = ({
  db,
  userId,
  pair,
}: Readonly<{
  db: D1Database;
  userId: string;
  pair: TransactionPair;
}>): Effect.Effect<Option.Option<TransactionRefusal>> =>
  Effect.tryPromise({
    try: () =>
      db
        .prepare(`SELECT
            (SELECT COUNT(*) FROM reconciled_transactions member
              WHERE member.user_id = ? AND member.transaction_id IN (?, ?)) AS member_total,
            (SELECT COUNT(*) FROM transactions retained
              WHERE retained.user_id = ? AND retained.id IN (?, ?)) AS row_total,
            (SELECT COUNT(*) FROM transactions first_retained
              INNER JOIN transactions second_retained
                ON second_retained.user_id = first_retained.user_id AND second_retained.id = ?
              WHERE first_retained.user_id = ? AND first_retained.id = ?
                AND first_retained.currency = second_retained.currency
                AND first_retained.amount = second_retained.amount
                AND first_retained.direction = second_retained.direction) AS eligible`)
        .bind(
          userId,
          pair.firstTransactionId,
          pair.secondTransactionId,
          userId,
          pair.firstTransactionId,
          pair.secondTransactionId,
          pair.secondTransactionId,
          userId,
          pair.firstTransactionId
        )
        .first(),
    catch: () => undefined,
  }).pipe(
    Effect.map((row) =>
      Option.flatMap(Schema.decodeUnknownOption(PairPremiseRow)(row), linkPremiseRefusalFor)
    ),
    Effect.orElseSucceed(() => Option.none())
  );

const unlinkPremiseRefusal = ({
  db,
  userId,
  pair,
}: Readonly<{
  db: D1Database;
  userId: string;
  pair: TransactionPair;
}>): Effect.Effect<Option.Option<TransactionRefusal>> =>
  Effect.tryPromise({
    try: () =>
      db
        .prepare(`SELECT state FROM transaction_reconciliation_decisions
          WHERE user_id = ? AND first_transaction_id = ? AND second_transaction_id = ?`)
        .bind(userId, pair.firstTransactionId, pair.secondTransactionId)
        .first(),
    catch: () => undefined,
  }).pipe(
    Effect.flatMap((row): Effect.Effect<Option.Option<TransactionRefusal>> =>
      Option.match(Schema.decodeUnknownOption(ReconciliationDecisionRow)(row), {
        onNone: () =>
          Effect.succeedSome({
            outcome: "validation_failed" as const,
            message: unlinkedPairMessage,
          }),
        onSome: (decision) =>
          decision.state === "linked"
            ? Effect.succeedNone
            : Effect.succeedSome({
                outcome: "validation_failed" as const,
                message: unlinkedPairMessage,
              }),
      })
    ),
    Effect.orElseSucceed(() => Option.none())
  );

const RevisionRow = Schema.Struct({ revision: Schema.Int });

const observedRevisionRefusal = ({
  db,
  userId,
  transactionId,
  expectedRevision,
  repeated,
}: Readonly<{
  db: D1Database;
  userId: string;
  transactionId: string;
  expectedRevision: number;
  repeated: boolean;
}>): Effect.Effect<Option.Option<TransactionRefusal>> =>
  Effect.gen(function* () {
    if (repeated) return Option.some(staleCorrectionRefusal);
    const row = yield* Effect.tryPromise(() =>
      db
        .prepare("SELECT revision FROM transactions WHERE user_id = ? AND id = ?")
        .bind(userId, transactionId)
        .first()
    ).pipe(Effect.orElseSucceed(() => undefined));
    const revision = Schema.decodeUnknownOption(RevisionRow)(row);
    return Option.isSome(revision) && revision.value.revision !== expectedRevision
      ? Option.some(staleCorrectionRefusal)
      : Option.none();
  });

export const transactionAbortRefusal = ({
  db,
  userId,
  outcome,
  repeated,
}: Readonly<{
  db: D1Database;
  userId: string;
  outcome: TransactionOutcome;
  repeated: boolean;
}>): Effect.Effect<Option.Option<TransactionRefusal>> => {
  if (Option.isSome(outcome.expectedRevision)) {
    return observedRevisionRefusal({
      db,
      userId,
      transactionId: outcome.transactionId,
      expectedRevision: outcome.expectedRevision.value,
      repeated,
    });
  }
  if (outcome.readback._tag === "Transaction" || outcome.readback._tag === "DeletedTransaction") {
    return Effect.succeedNone;
  }
  return outcome.readback._tag === "EffectiveTransaction"
    ? linkPremiseRefusal({ db, userId, pair: outcome.readback.pair })
    : unlinkPremiseRefusal({ db, userId, pair: outcome.readback.pair });
};

const TotalRow = Schema.Struct({ total: Schema.Int });

export const countRows = (statement: D1PreparedStatement): Promise<number> =>
  statement
    .first()
    .then((row) => Schema.decodeUnknownOption(TotalRow)(row))
    .then((row) => {
      if (Option.isNone(row)) throw new Error("Invalid capacity count projection");
      return row.value.total;
    });
