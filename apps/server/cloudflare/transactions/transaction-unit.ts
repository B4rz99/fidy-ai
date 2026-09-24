import { DateTime, Effect, Exit, Option, Schema } from "effect";
import type { CanonicalCapability } from "@fidy/server/canonical-runtime";
import { transactionCaptureCompletion } from "@fidy/server/transaction-capture";
import { Transaction } from "@fidy/server/transactions-runtime";
import {
  type TransactionCaller,
  type TransactionMutationOperation,
  type TransactionRefusal,
  boundaryCause,
  childCaller,
  liveTransactionCaller,
  liveTransactionCredential,
  recordTransactionRefusal,
  refusedCredentialResponse,
  refusedTransactionResponse,
  rejectTransactionMutation,
  transactionNoStore,
  transactionUnavailable,
} from "./transaction-boundary";
import { type StoredTransaction, findTransaction } from "./transaction-history";

const Output = Schema.toCodecJson(Transaction);

/**
 * One owner-prepared Transaction mutation, ready to join a caller-owned D1 unit.
 *
 * `transactionId` is the Transaction the mutation addresses — a fresh id for capture, the
 * corrected id otherwise. `statements` are the guard-chained writes that must all commit, ending
 * in the mutation's success AuditLogEntry so the unit's final completion statement turns any
 * silently skipped guard into a rollback. `expectedRevision` is present only for corrections and
 * lets an aborted unit report the stale write as the child it belongs to. `requiredScope` is the
 * exact PAT capability the owner prepared the mutation under, so an aborted unit reports and
 * audits the refusal against the same child authority.
 */
export type PreparedTransactionMutation = Readonly<{
  operation: TransactionMutationOperation;
  transactionId: string;
  expectedRevision: Option.Option<number>;
  requiredScope: Option.Option<CanonicalCapability>;
  statements: ReadonlyArray<D1PreparedStatement>;
}>;

/** The owner's answer for one Transaction mutation before its caller-owned unit may commit. */
export type TransactionMutationPreparation =
  | Readonly<{ _tag: "Prepared"; mutation: PreparedTransactionMutation }>
  | Readonly<{ _tag: "Refused"; refusal: TransactionRefusal }>
  | Readonly<{ _tag: "CredentialRefused" }>
  | Readonly<{ _tag: "Unavailable" }>
  | Readonly<{ _tag: "Failed"; cause: unknown }>;

/** Build one owner refusal as the preparation every executor maps to its canonical response. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const refusedPreparation = (
  outcome: TransactionRefusal["outcome"],
  message: string
): TransactionMutationPreparation => ({ _tag: "Refused", refusal: { outcome, message } });

/** Build the closed preparation failure for a dependency defect the executor classifies. */
export const failedPreparation = (failure: unknown): TransactionMutationPreparation => ({
  _tag: "Failed",
  cause: boundaryCause(failure),
});

/** What one caller-owned D1 unit did with its ordered Transaction mutations. */
export type TransactionUnitExecution =
  | Readonly<{ _tag: "Committed"; results: ReadonlyArray<StoredTransaction> }>
  | Readonly<{ _tag: "Rejected"; callIndex: number; refusal: TransactionRefusal }>
  | Readonly<{ _tag: "CredentialRefused" }>
  | Readonly<{ _tag: "Unavailable" }>;

// Both budgets are enforced by the D1 triggers in the 0009/0010/0011 migrations; these values
// only attribute an aborted unit to the child that met the trigger, never admit or refuse work.
const manualDailyMovementBudget = 100;
const sharedDailyAuditBudget = 256;
const millisecondsPerDay = 86_400_000;
const RevisionRow = Schema.Struct({ revision: Schema.Int });
const TotalRow = Schema.Struct({ total: Schema.Int });
/** The one message both the individual caller and a batch child report for an exhausted day. */
export const dailyAuditMessage = "The caller's daily canonical write budget is exhausted.";
/** The one message both the individual caller and a batch child report for an observed revision. */
export const staleCorrectionMessage =
  "The Transaction changed since it was read. Re-read it and retry the correction.";
const dailyAuditRefusal: TransactionRefusal = {
  outcome: "resource_limit",
  message: dailyAuditMessage,
};

const countRows = (statement: D1PreparedStatement): Promise<number> =>
  statement
    .first()
    .then((row) => Schema.decodeUnknownOption(TotalRow)(row))
    .then((row) => (Option.isSome(row) ? row.value.total : 0));

const movementBudgetIndex = ({
  db,
  userId,
  current,
  mutations,
}: Readonly<{
  db: D1Database;
  userId: string;
  current: number;
  mutations: ReadonlyArray<PreparedTransactionMutation>;
}>): Promise<number> => {
  const createdAt = DateTime.formatIso(DateTime.makeUnsafe(current));
  return countRows(
    db
      .prepare(`SELECT count(*) AS total FROM transactions
        WHERE user_id = ? AND created_at >= substr(?, 1, 10) || 'T00:00:00.000Z'
        AND created_at < date(?, '+1 day') || 'T00:00:00.000Z'`)
      .bind(userId, createdAt, createdAt)
  ).then((existing) => {
    let inserted = 0;
    for (const [index, mutation] of mutations.entries()) {
      if (mutation.operation !== "transactions.createTransaction") continue;
      if (existing + inserted >= manualDailyMovementBudget) return index;
      inserted += 1;
    }
    return 0;
  });
};

const auditBudgetIndex = ({
  db,
  userId,
  current,
  mutations,
}: Readonly<{
  db: D1Database;
  userId: string;
  current: number;
  mutations: ReadonlyArray<PreparedTransactionMutation>;
}>): Promise<number> => {
  const start = Math.floor(current / millisecondsPerDay) * millisecondsPerDay;
  return countRows(
    db
      .prepare(`SELECT count(*) AS total FROM (
        SELECT 1 FROM transaction_audit WHERE user_id = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?
        UNION ALL
        SELECT 1 FROM pat_audit WHERE user_id = ?
        AND ((pat_id IS NOT NULL AND operation NOT LIKE 'pats.%') OR operation = 'pats.listPATs')
        AND occurred_at_ms >= ? AND occurred_at_ms < ?
        UNION ALL
        SELECT 1 FROM category_audit WHERE user_id = ? AND occurred_at_ms >= ? AND occurred_at_ms < ?
      )`)
      .bind(
        userId,
        start,
        start + millisecondsPerDay,
        userId,
        start,
        start + millisecondsPerDay,
        userId,
        start,
        start + millisecondsPerDay
      )
  ).then((count) => {
    const remaining = sharedDailyAuditBudget - count;
    return remaining >= 0 && remaining < mutations.length ? remaining : 0;
  });
};

const staleCorrectionIndex = ({
  db,
  userId,
  mutations,
}: Readonly<{
  db: D1Database;
  userId: string;
  mutations: ReadonlyArray<PreparedTransactionMutation>;
}>): Effect.Effect<Option.Option<number>> =>
  Effect.gen(function* () {
    const observed = new Map<string, number>();
    for (const [index, mutation] of mutations.entries()) {
      if (Option.isNone(mutation.expectedRevision)) continue;
      const key = `${mutation.transactionId}:${mutation.expectedRevision.value}`;
      // A repeated observed revision of one Transaction can never satisfy its guard: the earlier
      // child already advanced the revision inside the unit, so this child owns the aborted guard.
      if (observed.has(key)) return Option.some(index);
      observed.set(key, index);
      const row = yield* Effect.tryPromise(() =>
        db
          .prepare("SELECT revision FROM transactions WHERE user_id = ? AND id = ?")
          .bind(userId, mutation.transactionId)
          .first()
      ).pipe(Effect.orElseSucceed(() => undefined));
      const revision = Schema.decodeUnknownOption(RevisionRow)(row);
      if (Option.isSome(revision) && revision.value.revision !== mutation.expectedRevision.value) {
        return Option.some(index);
      }
    }
    return Option.none();
  });

const rejectRecorded = ({
  db,
  subject,
  current,
  mutations,
  callIndex,
  refusal,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  mutations: ReadonlyArray<PreparedTransactionMutation>;
  callIndex: number;
  refusal: TransactionRefusal;
}>): Effect.Effect<TransactionUnitExecution> => {
  const mutation = mutations[callIndex];
  if (mutation === undefined) return Effect.succeed({ _tag: "Unavailable" });
  return Effect.tryPromise(() =>
    recordTransactionRefusal({
      db,
      subject: childCaller(subject, mutation.requiredScope),
      outcome: refusal.outcome,
      operation: mutation.operation,
      current,
    })
  ).pipe(
    Effect.map((record): TransactionUnitExecution => {
      if (record === "credential_refused") return { _tag: "CredentialRefused" };
      if (record === "rate_limited") {
        return { _tag: "Rejected", callIndex, refusal: dailyAuditRefusal };
      }
      if (record === "unavailable") return { _tag: "Unavailable" };
      return { _tag: "Rejected", callIndex, refusal };
    }),
    Effect.orElseSucceed(() => ({ _tag: "Unavailable" }) as const)
  );
};

const readCommitted = ({
  db,
  userId,
  mutations,
}: Readonly<{
  db: D1Database;
  userId: string;
  mutations: ReadonlyArray<PreparedTransactionMutation>;
}>): Effect.Effect<Option.Option<ReadonlyArray<StoredTransaction>>> =>
  Effect.gen(function* () {
    const results: Array<StoredTransaction> = [];
    for (const mutation of mutations) {
      const found = yield* Effect.tryPromise(() =>
        findTransaction({ db, userId, id: mutation.transactionId })
      ).pipe(Effect.orElseSucceed(() => Option.none<StoredTransaction>()));
      if (Option.isNone(found)) return Option.none();
      results.push(found.value);
    }
    return Option.some(results);
  });

const classifyAbortedUnit = ({
  db,
  subject,
  current,
  mutations,
  cause,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  mutations: ReadonlyArray<PreparedTransactionMutation>;
  cause: unknown;
}>): Effect.Effect<TransactionUnitExecution> =>
  Effect.gen(function* () {
    const live = yield* Effect.tryPromise(() =>
      liveTransactionCredential({ db, subject, current })
    ).pipe(Effect.orElseSucceed(() => false));
    if (!live) return { _tag: "CredentialRefused" };
    const detail = String(cause);
    const refused = (
      callIndex: number,
      refusal: TransactionRefusal
    ): Effect.Effect<TransactionUnitExecution> =>
      rejectRecorded({ db, subject, current, mutations, callIndex, refusal });
    if (detail.includes("transaction_resource_limit")) {
      const index = yield* Effect.tryPromise(() =>
        movementBudgetIndex({ db, userId: subject.userId, current, mutations })
      ).pipe(Effect.orElseSucceed(() => 0));
      return yield* refused(index, {
        outcome: "resource_limit",
        message: "The caller's manual Transaction budget is exhausted for today.",
      });
    }
    if (detail.includes("transaction_audit_limit")) {
      const index = yield* Effect.tryPromise(() =>
        auditBudgetIndex({ db, userId: subject.userId, current, mutations })
      ).pipe(Effect.orElseSucceed(() => 0));
      return { _tag: "Rejected", callIndex: index, refusal: dailyAuditRefusal };
    }
    const stale = yield* staleCorrectionIndex({ db, userId: subject.userId, mutations }).pipe(
      Effect.orElseSucceed(() => Option.none<number>())
    );
    if (Option.isSome(stale)) {
      return yield* refused(stale.value, {
        outcome: "validation_failed",
        message: staleCorrectionMessage,
      });
    }
    return { _tag: "Unavailable" };
  });

/**
 * Commit one ordered set of owner-prepared Transaction mutations in a single D1 atomic unit and
 * read each committed Transaction back. Every mutation is followed by the owner's completion
 * statement, so a guard that silently changes no row aborts the whole unit instead of being
 * noticed after a successful commit. The unit never opens a nested D1 unit and never performs
 * provider work; an aborted unit is classified against the same live credential and budgets the
 * individual operations check.
 */
export const executeTransactionUnit = ({
  db,
  subject,
  current,
  mutations,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  mutations: ReadonlyArray<PreparedTransactionMutation>;
}>): Effect.Effect<TransactionUnitExecution> =>
  Effect.gen(function* () {
    if (mutations.length === 0) return { _tag: "Unavailable" } as const;
    const statements = mutations.flatMap((mutation) => [
      ...mutation.statements,
      db.prepare(transactionCaptureCompletion),
    ]);
    const attempt = yield* Effect.exit(Effect.tryPromise(() => db.batch(statements)));
    if (Exit.isFailure(attempt)) {
      return yield* classifyAbortedUnit({ db, subject, current, mutations, cause: attempt.cause });
    }
    const results = yield* readCommitted({ db, userId: subject.userId, mutations });
    return Option.isSome(results)
      ? { _tag: "Committed", results: results.value }
      : { _tag: "Unavailable" };
  });

const unitResponse = ({
  db,
  subject,
  execution,
  status,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  execution: TransactionUnitExecution;
  status: number;
}>): Effect.Effect<Response> => {
  switch (execution._tag) {
    case "Committed": {
      const stored = execution.results[0];
      return stored === undefined
        ? Effect.succeed(transactionUnavailable())
        : Schema.encodeEffect(Output)(stored).pipe(
            Effect.map((data) =>
              Response.json({ data, next: [] }, { status, headers: transactionNoStore })
            ),
            Effect.orElseSucceed(transactionUnavailable)
          );
    }
    case "Rejected":
      return Effect.succeed(refusedTransactionResponse(execution.refusal));
    case "CredentialRefused":
      return refusedCredentialResponse({ db, subject });
    case "Unavailable":
      return Effect.succeed(transactionUnavailable());
  }
};

const failedPreparationResponse = ({
  db,
  subject,
  current,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
}>): Effect.Effect<Response> =>
  Effect.tryPromise(() => liveTransactionCaller({ db, subject, current })).pipe(
    Effect.orElseSucceed(() => false),
    Effect.flatMap((live) =>
      live ? Effect.succeed(transactionUnavailable()) : refusedCredentialResponse({ db, subject })
    )
  );

/**
 * Execute one owner-prepared Transaction mutation as its own caller-owned unit and map every
 * outcome to its canonical individual response. This is the individual half of the same
 * implementation the atomic batch composes, so validation, live authority, refusal Audit, and
 * commit classification cannot drift between them.
 */
export const executeSingleTransactionMutation = ({
  db,
  subject,
  current,
  operation,
  preparation,
  status,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  operation: TransactionMutationOperation;
  preparation: TransactionMutationPreparation;
  status: number;
}>): Effect.Effect<Response> => {
  switch (preparation._tag) {
    case "Refused":
      return Effect.tryPromise(() =>
        rejectTransactionMutation({ db, subject, operation, refusal: preparation.refusal, current })
      ).pipe(Effect.orElseSucceed(transactionUnavailable));
    case "CredentialRefused":
      return refusedCredentialResponse({ db, subject });
    case "Unavailable":
      return Effect.succeed(transactionUnavailable());
    case "Failed":
      return failedPreparationResponse({ db, subject, current });
    case "Prepared":
      return executeTransactionUnit({
        db,
        subject,
        current,
        mutations: [preparation.mutation],
      }).pipe(Effect.flatMap((execution) => unitResponse({ db, subject, execution, status })));
  }
};
