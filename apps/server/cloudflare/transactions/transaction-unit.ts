import { DateTime, Effect, Exit, Option, Schema } from "effect";
import type { CanonicalCapability } from "@fidy/server/canonical-runtime";
import {
  RestoredTransactionPair,
  TransactionPresentation,
} from "@fidy/server/transactions-runtime";
import type { TransactionPair } from "@fidy/server/transaction-reconciliation";
import { transactionCaptureCompletion } from "@fidy/server/transaction-capture";
import {
  ReconciliationDecisionRow,
  type TransactionCaller,
  type TransactionMutationOperation,
  type TransactionRefusal,
  alreadyLinkedMessage,
  childCaller,
  dailyAuditBudget,
  dailyAuditCount,
  liveTransactionAuthority,
  liveTransactionCredential,
  missingTransactionMessage,
  pairPolicyMessage,
  recordTransactionRefusal,
  refusedCredentialResponse,
  refusedTransactionResponse,
  rejectTransactionMutation,
  transactionNoStore,
  transactionUnavailable,
  unlinkedPairMessage,
} from "./transaction-boundary";
import {
  type StoredTransaction,
  TransactionOutput,
  findTransaction,
  findTransactionPresentation,
} from "./transaction-history";

/** How one committed mutation presents the records its response reads back. */
export type TransactionMutationResponse =
  | Readonly<{ _tag: "Transaction" }>
  /** The effective Transaction of one linked pair, presented as ordinary history returns it. */
  | Readonly<{ _tag: "EffectiveTransaction"; pair: TransactionPair }>
  /** The two independent originals one successful unlink restored, in canonical pair order. */
  | Readonly<{ _tag: "RestoredPair"; pair: TransactionPair }>;

/**
 * One owner-prepared Transaction mutation, ready to join a caller-owned D1 unit.
 *
 * `transactionId` is the primary Transaction the mutation addresses and reads back: a fresh id for
 * capture, the corrected id for a correction, the visible member for a link, and the canonical
 * first member for an unlink. `response` selects which canonical success value those readback
 * records present and, for a link or unlink, carries the canonically ordered Reconciliation pair it
 * decided, so an aborted unit can re-read the pair premise it may own. `statements` are the
 * guard-chained writes that must all commit, ending in the mutation's success AuditLogEntry (the
 * boundary's `acceptedPATStatements` for a PAT caller, the adapter's own browser statement
 * otherwise) so the unit's final completion statement turns any silently skipped guard into a
 * rollback. `expectedRevision` is present only for corrections and lets an aborted unit report the
 * stale write as the child it belongs to. `requiredScope` is the exact PAT capability the owner
 * prepared the mutation under, so an aborted unit reports and audits the refusal against the same
 * child authority.
 */
export type PreparedTransactionMutation = Readonly<{
  operation: TransactionMutationOperation;
  transactionId: string;
  response: TransactionMutationResponse;
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
  | Readonly<{ _tag: "Failed" }>;

/** Build one owner refusal as the preparation every executor maps to its canonical response. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const refusedPreparation = (
  outcome: TransactionRefusal["outcome"],
  message: string
): TransactionMutationPreparation => ({ _tag: "Refused", refusal: { outcome, message } });

/** Build the closed preparation failure for a dependency defect the executor classifies. */
export const failedPreparation = (): TransactionMutationPreparation => ({ _tag: "Failed" });

/** What one caller-owned D1 unit did with its ordered Transaction mutations. */
export type TransactionUnitExecution =
  | Readonly<{
      _tag: "Committed";
      /** One committed-record group per prepared mutation, in the order the unit read them back. */
      results: ReadonlyArray<ReadonlyArray<StoredTransaction>>;
    }>
  | Readonly<{ _tag: "Rejected"; callIndex: number; refusal: TransactionRefusal }>
  | Readonly<{ _tag: "CredentialRefused" }>
  | Readonly<{ _tag: "Unavailable" }>;

// The D1 triggers stay the atomic authority; this value only attributes an aborted unit to the
// child that met the trigger, never admits or refuses work.
const manualDailyMovementBudget = 100;
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
const staleCorrectionRefusal: TransactionRefusal = {
  outcome: "validation_failed",
  message: staleCorrectionMessage,
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
}>): Promise<number> =>
  dailyAuditCount({ db, userId, current }).then((count) => {
    const remaining = dailyAuditBudget - count;
    return remaining >= 0 && remaining < mutations.length ? remaining : 0;
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

const readbackIds = (mutation: PreparedTransactionMutation): ReadonlyArray<string> =>
  mutation.response._tag === "RestoredPair"
    ? [mutation.response.pair.firstTransactionId, mutation.response.pair.secondTransactionId]
    : [mutation.transactionId];

const readCommitted = ({
  db,
  userId,
  mutations,
}: Readonly<{
  db: D1Database;
  userId: string;
  mutations: ReadonlyArray<PreparedTransactionMutation>;
}>): Effect.Effect<Option.Option<ReadonlyArray<ReadonlyArray<StoredTransaction>>>> =>
  Effect.gen(function* () {
    const results: Array<ReadonlyArray<StoredTransaction>> = [];
    for (const mutation of mutations) {
      const records: Array<StoredTransaction> = [];
      for (const id of readbackIds(mutation)) {
        const found = yield* Effect.tryPromise(() => findTransaction({ db, userId, id })).pipe(
          Effect.orElseSucceed(() => Option.none<StoredTransaction>())
        );
        if (Option.isNone(found)) {
          return Option.none<ReadonlyArray<ReadonlyArray<StoredTransaction>>>();
        }
        records.push(found.value);
      }
      results.push(records);
    }
    return Option.some(results);
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
 * The first child an aborted unit can prove responsible from observed state, in child order: a
 * correction whose stored revision no longer matches (or that repeats an earlier child's observed
 * revision), then a link or unlink whose pair premise moved outside the unit. A premise or revision
 * that only the unit itself changed is invisible here because the unit rolled its writes back, so an
 * intra-batch conflict stays unattributable. Trigger-marker classes are attributed before this,
 * because the trigger that fired names the child rather than an inferred observation.
 */
const inferredAbortIndex = ({
  db,
  userId,
  mutations,
}: Readonly<{
  db: D1Database;
  userId: string;
  mutations: ReadonlyArray<PreparedTransactionMutation>;
}>): Effect.Effect<Option.Option<Readonly<{ index: number; refusal: TransactionRefusal }>>> =>
  Effect.gen(function* () {
    const observed = new Map<string, number>();
    for (const [index, mutation] of mutations.entries()) {
      if (Option.isSome(mutation.expectedRevision)) {
        const key = `${mutation.transactionId}:${mutation.expectedRevision.value}`;
        const repeated = observed.has(key);
        observed.set(key, index);
        const stale = yield* observedRevisionRefusal({
          db,
          userId,
          transactionId: mutation.transactionId,
          expectedRevision: mutation.expectedRevision.value,
          repeated,
        });
        if (Option.isSome(stale)) return Option.some({ index, refusal: stale.value });
        continue;
      }
      if (mutation.response._tag === "Transaction") continue;
      const refusal =
        mutation.response._tag === "EffectiveTransaction"
          ? yield* linkPremiseRefusal({ db, userId, pair: mutation.response.pair })
          : yield* unlinkPremiseRefusal({ db, userId, pair: mutation.response.pair });
      if (Option.isSome(refusal)) return Option.some({ index, refusal: refusal.value });
    }
    return Option.none();
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
    const inferred = yield* inferredAbortIndex({
      db,
      userId: subject.userId,
      mutations,
    }).pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isSome(inferred)) {
      return yield* refused(inferred.value.index, inferred.value.refusal);
    }
    return { _tag: "Unavailable" };
  });

/**
 * Commit one ordered set of owner-prepared Transaction mutations in a single D1 atomic unit and
 * read each committed Transaction back. Every mutation is followed by the owner's completion
 * statement, so a guard that silently changes no row aborts the whole unit instead of being
 * noticed after a successful commit. The unit never opens a nested D1 unit and never performs
 * provider work; an aborted unit is classified against the same live credential, budgets,
 * observed revision, and Reconciliation pair premises the individual operations check.
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

/** One committed mutation's canonical success value before a transport encodes it. */
export type CommittedMutationValue =
  | Readonly<{ _tag: "Transaction"; transaction: StoredTransaction }>
  | Readonly<{ _tag: "EffectiveTransaction"; transaction: TransactionPresentation }>
  | Readonly<{ _tag: "RestoredPair"; pair: RestoredTransactionPair }>;

/** The success payload one committed value carries, as the published operation success expects it. */
export const committedMutationPayload = (value: CommittedMutationValue): unknown => {
  switch (value._tag) {
    case "Transaction":
      return value.transaction;
    case "EffectiveTransaction":
      return value.transaction;
    case "RestoredPair":
      return value.pair;
  }
};

/**
 * The canonical success value one committed mutation's readback records present, or none when the
 * unit read back an incomplete set. The individual response and the atomic-batch child output
 * encode the same value; only the transport differs.
 */
export const committedMutationValue = ({
  db,
  userId,
  mutation,
  records,
}: Readonly<{
  db: D1Database;
  userId: string;
  mutation: PreparedTransactionMutation;
  records: ReadonlyArray<StoredTransaction>;
}>): Effect.Effect<Option.Option<CommittedMutationValue>> => {
  const first = records[0];
  if (first === undefined) return Effect.succeedNone;
  if (mutation.response._tag === "Transaction") {
    return Effect.succeedSome({ _tag: "Transaction", transaction: first });
  }
  if (mutation.response._tag === "RestoredPair") {
    const second = records[1];
    if (second === undefined) return Effect.succeedNone;
    return Effect.succeedSome({
      _tag: "RestoredPair",
      pair: {
        firstTransaction: { ...first, presentation: { kind: "independent" } },
        secondTransaction: { ...second, presentation: { kind: "independent" } },
      },
    });
  }
  return Effect.tryPromise({
    try: () => findTransactionPresentation({ db, userId, id: mutation.transactionId }),
    catch: () => undefined,
  }).pipe(
    Effect.flatMap((presentation) =>
      Option.isNone(presentation)
        ? Effect.succeedNone
        : Effect.succeedSome({
            _tag: "EffectiveTransaction" as const,
            transaction: presentation.value,
          })
    ),
    Effect.orElseSucceed(() => Option.none())
  );
};

const encodeCommittedValue = (
  value: CommittedMutationValue
): Effect.Effect<unknown, Schema.SchemaError> => {
  switch (value._tag) {
    case "Transaction":
      return Schema.encodeEffect(TransactionOutput)(value.transaction);
    case "EffectiveTransaction":
      return Schema.encodeEffect(Schema.toCodecJson(TransactionPresentation))(value.transaction);
    case "RestoredPair":
      return Schema.encodeEffect(Schema.toCodecJson(RestoredTransactionPair))(value.pair);
  }
};

const committedResponse = ({
  db,
  userId,
  mutation,
  records,
  status,
}: Readonly<{
  db: D1Database;
  userId: string;
  mutation: PreparedTransactionMutation;
  records: ReadonlyArray<StoredTransaction>;
  status: number;
}>): Effect.Effect<Response> =>
  committedMutationValue({ db, userId, mutation, records }).pipe(
    Effect.flatMap((data) => {
      if (Option.isNone(data)) return Effect.succeed(transactionUnavailable());
      return encodeCommittedValue(data.value).pipe(
        Effect.map((json) =>
          Response.json({ data: json, next: [] }, { status, headers: transactionNoStore })
        ),
        Effect.orElseSucceed(transactionUnavailable)
      );
    })
  );

const unitResponse = ({
  db,
  subject,
  mutation,
  execution,
  status,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  mutation: PreparedTransactionMutation;
  execution: TransactionUnitExecution;
  status: number;
}>): Effect.Effect<Response> => {
  switch (execution._tag) {
    case "Committed":
      return committedResponse({
        db,
        userId: subject.userId,
        mutation,
        records: execution.results[0] ?? [],
        status,
      });
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
  Effect.tryPromise(() => liveTransactionAuthority({ db, subject, current })).pipe(
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
      }).pipe(
        Effect.flatMap((execution) =>
          unitResponse({
            db,
            subject,
            mutation: preparation.mutation,
            execution,
            status,
          })
        )
      );
  }
};
