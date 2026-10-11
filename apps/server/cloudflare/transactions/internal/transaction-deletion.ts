import { Effect, Option, Schema } from "effect";
import { TransactionId } from "../../../src/core/transactions/contract";
import { prepareOwnerAuditCall } from "../../../src/shell/audit/operations";
import type { CanonicalMutationPreparation } from "../../canonical-operations/contract";
import {
  type TransactionCaller,
  type TransactionRefusal,
  acceptedOAuthStatement,
  acceptedPATStatements,
  boundaryFailure,
  callerAuthority,
  callerScope,
  credentialRefusedPreparation,
  failedPreparation,
  isOAuthCaller,
  isPATCaller,
  liveTransactionAuthority,
  missingTransactionMessage,
  transactionId,
} from "../../canonical-work/operations";
import type { TransactionOutcome } from "../contract";
import {
  type ObservedTransactions,
  discloseTransactions,
  observeOAuthTransactions,
} from "./oauth-review";
import { type StoredTransaction, findTransaction } from "./transaction-history";
import { refusedTransactionMutation, transactionGuardRefusal } from "./transaction-outcome";

const operation = "transactions.deleteTransaction";
const linkedMessage = "Unlink the Transaction pair before deleting either original Transaction.";
const Membership = Schema.Struct({ total: Schema.Int });

type DeletionInput = Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  id: string;
  current: number;
}>;
const deletionAudit = ({
  db,
  subject,
  id,
  current,
}: DeletionInput): ReadonlyArray<D1PreparedStatement> => {
  if (isOAuthCaller(subject)) {
    return [acceptedOAuthStatement({ db, subject, operation, current })];
  }
  if (isPATCaller(subject)) {
    return acceptedPATStatements({ db, subject, operation, current });
  }
  return [
    prepareOwnerAuditCall({
      db,
      id: transactionId(),
      userId: subject.userId,
      caller: { _tag: "WebSession", id: subject.id },
      operation,
      outcome: "success",
      current,
      afterOwnerWrite: true,
      when: {
        sql: "SELECT 1 FROM transactions WHERE user_id = ? AND id = ? AND deleted_at_ms = ?",
        params: [subject.userId, id, current],
      },
    }),
  ];
};
const preparedDeletion = ({
  db,
  subject,
  id,
  current,
  owned,
  observed,
}: DeletionInput &
  Readonly<{
    owned: StoredTransaction;
    observed: Option.Option<ObservedTransactions>;
  }>): CanonicalMutationPreparation => {
  const authority = callerAuthority({ subject, current });
  const outcome: TransactionOutcome = {
    _tag: "Transaction",
    operation,
    transactionId: id,
    readback: { _tag: "DeletedTransaction" },
    expectedRevision: Option.some(owned.revision),
  };
  return {
    _tag: "Prepared" as const,
    mutation: {
      outcome,
      requiredScope: callerScope(subject),
      auditBudget: "shared" as const,
      commitGuards: Option.none(),
      guardRefusal: transactionGuardRefusal(outcome),
      oauthReview: Option.isSome(observed)
        ? observed.value.review(
            `Eliminar permanentemente la Transacción ${id}, revisión ${owned.revision}: ${discloseTransactions([owned])}. No se puede restaurar; se conservan las SourceAttestations.`
          )
        : Option.none(),
      statements: [
        db
          .prepare(`UPDATE transactions SET deleted_at_ms = ?
        WHERE user_id = ? AND id = ? AND revision = ? AND deleted_at_ms IS NULL
        AND NOT EXISTS (SELECT 1 FROM transaction_reconciliation_members WHERE user_id = ? AND transaction_id = ?)
        AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
          .bind(
            current,
            subject.userId,
            id,
            owned.revision,
            subject.userId,
            id,
            ...authority.bindings
          ),
        ...deletionAudit({ db, subject, id, current }),
      ],
    },
  };
};

/** Prepare permanent visibility removal with revision, live authority, and unlinked-original guards. */
export const prepareDeletion = ({
  db,
  subject,
  id,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  id: string;
  current: number;
}>): Effect.Effect<CanonicalMutationPreparation> =>
  Effect.gen(function* () {
    const refuse = (refusal: TransactionRefusal): CanonicalMutationPreparation =>
      refusedTransactionMutation({ db, subject, operation, refusal, current });
    if (Option.isNone(Schema.decodeOption(TransactionId)(id))) {
      return refuse({ outcome: "not_found", message: missingTransactionMessage });
    }
    const live = yield* Effect.tryPromise({
      try: () => liveTransactionAuthority({ db, subject, current }),
      catch: boundaryFailure,
    });
    if (!live) {
      return credentialRefusedPreparation();
    }
    const observed = isOAuthCaller(subject)
      ? Option.some(
          yield* observeOAuthTransactions({ db, userId: subject.userId, firstId: id, secondId: id })
        )
      : Option.none();
    const owned = Option.isSome(observed)
      ? Option.fromUndefinedOr(observed.value.retained.find((transaction) => transaction.id === id))
      : yield* Effect.tryPromise({
          try: () => findTransaction({ db, userId: subject.userId, id }),
          catch: boundaryFailure,
        });
    if (Option.isNone(owned)) {
      return refuse({ outcome: "not_found", message: missingTransactionMessage });
    }
    const membership = yield* Effect.tryPromise({
      try: () =>
        db
          .prepare(
            "SELECT COUNT(*) AS total FROM transaction_reconciliation_members WHERE user_id = ? AND transaction_id = ?"
          )
          .bind(subject.userId, id)
          .first(),
      catch: boundaryFailure,
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Membership)));
    if (membership.total > 0) {
      return refuse({ outcome: "validation_failed", message: linkedMessage });
    }
    return preparedDeletion({ db, subject, id, current, owned: owned.value, observed });
  }).pipe(Effect.orElseSucceed(failedPreparation));
