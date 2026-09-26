import { DateTime, Effect, Option, Schema } from "effect";
import type { TransactionPair } from "@fidy/server/transaction-reconciliation";
import type {
  CanonicalMutationOutcome,
  CanonicalMutationPreparation,
  CanonicalMutationRefusal,
  CommittedMutationValue,
  TransactionOutcome,
} from "./mutation-types";
import { refusedPreparation } from "./mutation-types";
import {
  ReconciliationDecisionRow,
  type TransactionBoundaryFailure,
  type TransactionCaller,
  type TransactionMutationOperation,
  type TransactionRefusal,
  alreadyLinkedMessage,
  boundaryFailure,
  missingTransactionMessage,
  pairPolicyMessage,
  rateLimitedTransactionResponse,
  recordTransactionRefusal,
  refusalFailureCode,
  refusedCredentialResponse,
  refusedTransactionResponse,
  transactionUnavailable,
  unlinkedPairMessage,
} from "../transactions/transaction-boundary";
import {
  type StoredTransaction,
  findTransaction,
  findTransactionPresentation,
} from "../transactions/transaction-history";
import type { TransactionPresentation } from "@fidy/server/transactions-runtime";

/** The one message both the individual caller and a batch child report for an observed revision. */
export const staleCorrectionMessage =
  "The Transaction changed since it was read. Re-read it and retry the correction.";
/** The one message both the individual caller and a batch child report for an exhausted day. */
export const dailyAuditMessage = "The caller's daily canonical write budget is exhausted.";
const staleCorrectionRefusal: TransactionRefusal = {
  outcome: "validation_failed",
  message: staleCorrectionMessage,
};

/**
 * Build one Transaction refusal: it records the metadata-only refusal Audit under the exact child
 * authority and renders the same individual response the operation's own entry point returns.
 */
export const transactionRefusal = ({
  db,
  subject,
  operation,
  refusal,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
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
      case "rate_limited":
        return Effect.succeed(rateLimitedTransactionResponse());
      case "unavailable":
        return Effect.succeed(transactionUnavailable());
    }
  },
});

/**
 * One decided Transaction refusal as the preparation every owner executor maps to its canonical
 * response. Each owner names only its operation and refusal; the evidence recording stays here.
 */
export const refusedTransactionMutation = ({
  db,
  subject,
  operation,
  refusal,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  operation: TransactionMutationOperation;
  refusal: TransactionRefusal;
  current: number;
}>): CanonicalMutationPreparation =>
  refusedPreparation(transactionRefusal({ db, subject, operation, refusal, current }));

/**
 * The refusal a Transaction child reports when the shared daily audit budget, not the child,
 * refused its unit. The canonical limited result is rendered without a refusal AuditLogEntry: the
 * budget that refused the work is the same one the record would consume.
 */
export const transactionBudgetRefusal = (): CanonicalMutationRefusal => ({
  code: "rate_limited",
  message: dailyAuditMessage,
  record: () => Effect.succeed("rate_limited" as const),
  respond: () => Effect.succeed(rateLimitedTransactionResponse()),
});

/**
 * Read the records one committed Transaction child presents, or None when the unit read back an
 * incomplete set. The individual response and the atomic-batch child output encode the same value.
 */
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
    if (outcome.readback._tag === "Transaction") {
      const found = yield* Effect.tryPromise(() =>
        findTransaction({ db, userId, id: outcome.transactionId })
      ).pipe(Effect.orElseSucceed(() => Option.none<StoredTransaction>()));
      return Option.map(found, (transaction) => ({ _tag: "Transaction" as const, transaction }));
    }
    if (outcome.readback._tag === "EffectiveTransaction") {
      // The effective Transaction is presented from its link, not from the stored row, so this
      // read is the whole readback: the row it pairs with is not read at all.
      const presentation = yield* Effect.tryPromise(() =>
        findTransactionPresentation({ db, userId, id: outcome.transactionId })
      ).pipe(Effect.orElseSucceed(() => Option.none<TransactionPresentation>()));
      return Option.map(presentation, (transaction) => ({
        _tag: "EffectiveTransaction" as const,
        transaction,
      }));
    }
    const records: Array<StoredTransaction> = [];
    for (const id of [
      outcome.readback.pair.firstTransactionId,
      outcome.readback.pair.secondTransactionId,
    ]) {
      const found = yield* Effect.tryPromise(() => findTransaction({ db, userId, id })).pipe(
        Effect.orElseSucceed(() => Option.none<StoredTransaction>())
      );
      if (Option.isNone(found)) return Option.none<CommittedMutationValue>();
      records.push(found.value);
    }
    const first = records[0];
    const second = records[1];
    if (first === undefined || second === undefined) return Option.none<CommittedMutationValue>();
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

/** The refusal one link premise reports, or none while the pair can still link. */
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

/** The refusal one link whose pair premise moved before commit reports, or none when it still holds. */
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
            (SELECT COUNT(*) FROM transaction_reconciliation_members member
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

/** The refusal one unlink whose decision stopped being linked before commit reports, or none. */
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

/**
 * The refusal one correction child reports when its observed revision can no longer satisfy its
 * guard, or none while the guard can still commit. `repeated` is true when an earlier child already
 * observed the same revision of the same Transaction: the earlier child advanced the revision
 * inside the unit, so this child owns the aborted guard.
 */
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

/**
 * The refusal one Transaction child explains for an aborted unit, or None when it cannot. A
 * correction whose stored revision no longer matches (or that repeats an earlier child's observed
 * revision) comes first, then a link or unlink whose pair premise moved outside the unit. A premise
 * or revision that only the unit itself changed is invisible here because the unit rolled back, so
 * an intra-batch conflict stays unattributable.
 */
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
  if (outcome.readback._tag === "Transaction") return Effect.succeedNone;
  return outcome.readback._tag === "EffectiveTransaction"
    ? linkPremiseRefusal({ db, userId, pair: outcome.readback.pair })
    : unlinkPremiseRefusal({ db, userId, pair: outcome.readback.pair });
};

const TotalRow = Schema.Struct({ total: Schema.Int });

/** Decode the count from one D1 aggregate; a missing or malformed row is unavailable. */
export const countRows = (statement: D1PreparedStatement): Promise<number> =>
  statement
    .first()
    .then((row) => Schema.decodeUnknownOption(TotalRow)(row))
    .then((row) => {
      if (Option.isNone(row)) throw new Error("Invalid capacity count projection");
      return row.value.total;
    });

/** How many manual movements one User may create per UTC day before a capture child is blamed. */
const manualDailyMovementBudget = 100;

/**
 * The capture child a manual-movement budget abort blames: the child the replay finds over budget,
 * otherwise the first capture child the trigger can belong to, and None when the unit holds no
 * capture child. The count reads committed state because the unit rolled back, then replays the
 * children in order.
 */
export const transactionMovementIndex = ({
  db,
  userId,
  current,
  mutations,
}: Readonly<{
  db: D1Database;
  userId: string;
  current: number;
  mutations: ReadonlyArray<{ readonly outcome: CanonicalMutationOutcome }>;
}>): Effect.Effect<Option.Option<number>, TransactionBoundaryFailure> => {
  const createdAt = DateTime.formatIso(DateTime.makeUnsafe(current));
  return Effect.tryPromise({
    try: () =>
      countRows(
        db
          .prepare(`SELECT count(*) AS total FROM transactions
        WHERE user_id = ? AND created_at >= substr(?, 1, 10) || 'T00:00:00.000Z'
        AND created_at < date(?, '+1 day') || 'T00:00:00.000Z'`)
          .bind(userId, createdAt, createdAt)
      ),
    catch: boundaryFailure,
  }).pipe(
    Effect.map((existing) => {
      let inserted = 0;
      let firstOwned: Option.Option<number> = Option.none();
      for (const [index, mutation] of mutations.entries()) {
        if (
          mutation.outcome._tag !== "Transaction" ||
          mutation.outcome.operation !== "transactions.createTransaction"
        ) {
          continue;
        }
        if (Option.isNone(firstOwned)) firstOwned = Option.some(index);
        if (existing + inserted >= manualDailyMovementBudget) return Option.some(index);
        inserted += 1;
      }
      return firstOwned;
    })
  );
};

/** The refusal a capture child reports when the daily manual-movement budget aborts its unit. */
export const transactionMovementRefusal = (): TransactionRefusal => ({
  outcome: "resource_limit",
  message: "The caller's manual Transaction budget is exhausted for today.",
});
