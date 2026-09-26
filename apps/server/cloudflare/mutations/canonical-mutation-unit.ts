import { Effect, Exit, Option, Schema } from "effect";
import { maximumAtomicBatchCalls } from "@fidy/server/canonical-runtime";
import {
  auditDayBindings,
  auditDayCountExpression,
  dailyAuditBudget,
} from "../atomic/daily-canonical-budget";
import { KeywordRule, KeywordRuleId } from "@fidy/server/categories";
import { Memory, MemoryId } from "@fidy/server/memory-runtime";
import { Budget, BudgetId } from "@fidy/server/budgets-runtime";
import { InsightDeliveryAttempt, InsightEvent } from "@fidy/server/insights-runtime";
import { findInsight, findInsightAttempt } from "../insights/insight-store";
import { budgetAuditLimitRefusal, findBudgetValue } from "../budgets/budget-outcome";
import { StatementSubmission } from "@fidy/server/statement-staging";
import { EmailForwardingAddress } from "../../src/core/ingestion/model";
import { readForwardingAddress } from "../ingestion/forwarding-address";
import {
  RestoredTransactionPair,
  TransactionPresentation,
} from "@fidy/server/transactions-runtime";
import { canonicalTriggerNames, canonicalTriggerOf } from "../audit/audit-triggers";
import {
  lostStatementReplay,
  readOwnedStatementSubmission,
  submissionProjection,
} from "../ingestion/statement-staging";
import {
  type CanonicalRefusalDisposition,
  type TransactionCaller,
  childCaller,
  liveTransactionAuthority,
  liveTransactionCredential,
  refusedCredentialResponse,
  transactionNoStore,
  transactionUnavailable,
} from "../transactions/transaction-boundary";
import { TransactionOutput } from "../transactions/transaction-history";
import { findKeywordRuleValue, keywordRuleBudgetRefusal } from "./keyword-rule-outcome";
import { findMemoryValue, memoryBudgetRefusal } from "./memory-outcome";
import {
  findTransactionValue,
  transactionBudgetRefusal,
  transactionMovementRefusal,
  transactionRefusal,
} from "./transaction-outcome";
import type {
  CanonicalMutationPreparation,
  CanonicalMutationRefusal,
  CommittedMutationValue,
  PreparedCanonicalMutation,
  TransactionOutcome,
} from "./mutation-types";

/** What one caller-owned D1 unit did with its ordered canonical mutations. */
export type CanonicalMutationUnitExecution =
  | Readonly<{
      _tag: "Committed";
      /** One canonical success value per prepared mutation, in the order the unit prepared them. */
      values: ReadonlyArray<CommittedMutationValue>;
    }>
  | Readonly<{
      _tag: "Rejected";
      callIndex: number;
      refusal: CanonicalMutationRefusal;
      disposition: CanonicalRefusalDisposition;
    }>
  | Readonly<{ _tag: "CredentialRefused" }>
  | Readonly<{ _tag: "Unavailable" }>
  | Readonly<{ _tag: "Aborted" }>;

/** The commit-time trigger classes one aborted unit can name by its own D1 constraint message. */
type TriggerKind = "movement" | "audit";

/** A child's canonical identity is fixed by its owner's prepared outcome, never by D1's error. */
const mutationOperation = (mutation: PreparedCanonicalMutation): string =>
  mutation.outcome.operation;

/** Reuse the owner's changes() completion premise while binding each child's identity to its slot. */
const childCompletion = (db: D1Database, index: number, operation: string): D1PreparedStatement =>
  db
    .prepare(`INSERT INTO canonical_child_guard (child_index, operation, accepted)
    VALUES (?, ?, CASE WHEN changes() = 1 THEN 1 ELSE 0 END)
    ON CONFLICT(child_index) DO UPDATE SET operation = excluded.operation,
      accepted = excluded.accepted`)
    .bind(index, operation);

/** Check the shared Audit count atomically before the child's success Audit. */
const childBudget = ({
  db,
  userId,
  current,
  index,
  operation,
}: Readonly<{
  db: D1Database;
  userId: string;
  current: number;
  index: number;
  operation: string;
}>): D1PreparedStatement =>
  db
    .prepare(`INSERT INTO canonical_child_guard (child_index,operation,accepted,budget_ok)
    SELECT ?,?,1,CASE WHEN (${auditDayCountExpression}) < ? THEN 1 ELSE 0 END
    ON CONFLICT(child_index) DO UPDATE SET operation = excluded.operation,
      accepted = excluded.accepted, budget_ok = excluded.budget_ok`)
    .bind(index, operation, ...auditDayBindings({ userId, current }), dailyAuditBudget);

/** Decode only a known CHECK failure; a trigger with similar prose is not proof of a child. */
const childGuardMarker = (
  cause: unknown
): Option.Option<
  Readonly<{ index: number; kind: "completion" | "budget" | "movement" | "capacity" }>
> => {
  const detail = String(cause);
  // SQLite appends the actual extended code after trigger-supplied prose. A forged CHECK phrase
  // inside a RAISE(ABORT) message still ends with SQLITE_CONSTRAINT_TRIGGER and is not trusted.
  if (detail.includes("extended: SQLITE_CONSTRAINT_TRIGGER")) return Option.none();
  const match =
    /D1_ERROR: CHECK constraint failed: canonical_child_(guard|budget|movement|capacity)_(0|[1-9]|10|11): SQLITE_CONSTRAINT \(extended: SQLITE_CONSTRAINT_CHECK\)/u.exec(
      detail
    );
  if (match === null) return Option.none();
  const index = Number(match[2]);
  if (index >= maximumAtomicBatchCalls) return Option.none();
  if (match[1] === "budget") return Option.some({ index, kind: "budget" as const });
  if (match[1] === "movement") return Option.some({ index, kind: "movement" as const });
  if (match[1] === "capacity") return Option.some({ index, kind: "capacity" as const });
  return Option.some({ index, kind: "completion" as const });
};

/** A shared Audit trigger without a child marker is provable only in a single-child unit. */
const auditBudgetIndex = (
  mutations: ReadonlyArray<PreparedCanonicalMutation>
): Option.Option<number> => (mutations.length === 1 ? Option.some(0) : Option.none());

/**
 * Record one already-decided child refusal and report how the unit's caller must answer it.
 * `record` never fails by contract; a future fallible refusal must widen the contract first,
 * failing to build here until the unit answers the new failure.
 */
const rejectRecorded = ({
  callIndex,
  refusal,
}: Readonly<{
  callIndex: number;
  refusal: CanonicalMutationRefusal;
}>): Effect.Effect<CanonicalMutationUnitExecution> =>
  refusal.record().pipe(
    Effect.map((disposition): CanonicalMutationUnitExecution => {
      if (disposition === "credential_refused") return { _tag: "CredentialRefused" };
      if (disposition === "unavailable") return { _tag: "Unavailable" };
      return { _tag: "Rejected", callIndex, refusal, disposition };
    })
  );

const nonTransactionAuditLimitRefusal = (
  source: "ForwardingAddress" | "StatementSubmission"
): CanonicalMutationRefusal => ({
  code: "rate_limited",
  message:
    source === "ForwardingAddress"
      ? "Daily canonical work budget exhausted."
      : "Too many statement calls today; retry after the daily budget resets.",
  record: () => Effect.succeed("rate_limited" as const),
  respond: () => Effect.succeed(transactionUnavailable()),
});

/**
 * The refusal one prepared child explains for a commit-time trigger, or None when the trigger
 * class does not belong to that child's owner. The refusal records its own evidence under the exact
 * child scope, so a rejection the unit attributes is audited like the individual refusal it is.
 */
const triggerRefusal = ({
  db,
  subject,
  current,
  mutation,
  kind,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  mutation: PreparedCanonicalMutation;
  kind: TriggerKind;
}>): Option.Option<CanonicalMutationRefusal> => {
  const scoped = childCaller(subject, mutation.requiredScope);
  const auditOnly = (refusal: CanonicalMutationRefusal): Option.Option<CanonicalMutationRefusal> =>
    kind === "audit" ? Option.some(refusal) : Option.none();
  switch (mutation.outcome._tag) {
    case "Budget":
    case "Insight":
      return auditOnly(budgetAuditLimitRefusal());
    case "Transaction":
      return transactionTriggerRefusal({
        db,
        subject: scoped,
        current,
        outcome: mutation.outcome,
        kind,
      });
    case "KeywordRule":
      return auditOnly(keywordRuleBudgetRefusal());
    case "Memory":
      return auditOnly(memoryBudgetRefusal());
    case "ForwardingAddress":
    case "StatementSubmission":
      return auditOnly(nonTransactionAuditLimitRefusal(mutation.outcome._tag));
  }
};

/** The refusal a Transaction child reports for a trigger that belongs to its own owner. */
const transactionTriggerRefusal = ({
  db,
  subject,
  current,
  outcome,
  kind,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  outcome: TransactionOutcome;
  kind: TriggerKind;
}>): Option.Option<CanonicalMutationRefusal> => {
  if (kind === "movement") {
    return Option.some(
      transactionRefusal({
        db,
        subject,
        operation: outcome.operation,
        refusal: transactionMovementRefusal(),
        current,
      })
    );
  }
  return Option.some(transactionBudgetRefusal());
};

/**
 * The child index and trigger class one aborted unit's D1 constraint names, or None when the
 * message is not a known commit-time trigger or no child in the unit can be named as its cause.
 * The value attributes an abort; the triggers themselves remain the atomic authority that admitted
 * or refused the work.
 */
const triggerAttribution = ({
  mutations,
  detail,
}: Readonly<{
  mutations: ReadonlyArray<PreparedCanonicalMutation>;
  detail: string;
}>): Option.Option<Readonly<{ index: number; kind: TriggerKind }>> => {
  const trigger = canonicalTriggerOf(detail);
  if (Option.isNone(trigger)) return Option.none();
  // Every declared trigger name is matched here, so a new one must name the child class it
  // blames or this build fails.
  switch (trigger.value) {
    case canonicalTriggerNames.resourceLimit:
      // Recounting after rollback can include another caller's commit: no indexed CHECK, no owner.
      return Option.none();
    case canonicalTriggerNames.keywordRuleLimit:
      // Rolled-back deletions make a capacity recount unsound; only indexed owner CHECKs prove it.
      return Option.none();
    case canonicalTriggerNames.memoryCapacity:
      // A committed-state replay misses earlier forgets and concurrent writes; require indexed proof.
      return Option.none();
    case canonicalTriggerNames.auditLimit: {
      const index = auditBudgetIndex(mutations);
      return Option.map(index, (value) => ({ index: value, kind: "audit" as const }));
    }
  }
};

/** Record one attributed trigger's child refusal, or answer Unavailable when it names no owner. */
const refuseAttributed = ({
  db,
  subject,
  current,
  mutations,
  index,
  kind,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  mutations: ReadonlyArray<PreparedCanonicalMutation>;
  index: number;
  kind: TriggerKind;
}>): Effect.Effect<CanonicalMutationUnitExecution> => {
  const mutation = mutations[index];
  const refusal =
    mutation === undefined
      ? Option.none<CanonicalMutationRefusal>()
      : triggerRefusal({ db, subject, current, mutation, kind });
  return Option.isNone(refusal)
    ? Effect.succeed({ _tag: "Unavailable" } as const)
    : rejectRecorded({ callIndex: index, refusal: refusal.value });
};

/** Attribute an owner's indexed completion or capacity assertion only to the child it names. */
const refuseChildGuard = ({
  db,
  subject,
  current,
  mutations,
  index,
  kind,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  mutations: ReadonlyArray<PreparedCanonicalMutation>;
  index: number;
  kind: "completion" | "capacity";
}>): Effect.Effect<CanonicalMutationUnitExecution> =>
  Effect.gen(function* () {
    const mutation = mutations[index];
    if (mutation === undefined) return { _tag: "Unavailable" } as const;
    const scoped = childCaller(subject, mutation.requiredScope);
    // A same-material publication that won the race is a retry, not a refused child.
    if (
      mutation.outcome._tag === "StatementSubmission" &&
      (yield* lostStatementReplay(mutation.outcome.config, mutation.outcome.publication))
    ) {
      return { _tag: "Aborted" } as const;
    }
    const refusal = yield* mutation.guardRefusal({
      db,
      subject: scoped,
      current,
      earlier: mutations.slice(0, index).map((value) => value.outcome),
      kind,
    });
    return yield* rejectRecorded({ callIndex: index, refusal });
  });

const isOwnerGuard = (
  kind: "completion" | "capacity" | "movement" | "budget"
): kind is "completion" | "capacity" => kind === "completion" || kind === "capacity";

/** Classify a child-specific CHECK, refusing unknown lookalikes without guessing a child. */
const markedAbort = ({
  db,
  subject,
  current,
  mutations,
  cause,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  mutations: ReadonlyArray<PreparedCanonicalMutation>;
  cause: unknown;
}>): Option.Option<Effect.Effect<CanonicalMutationUnitExecution>> => {
  const marker = childGuardMarker(cause);
  if (Option.isSome(marker)) {
    return Option.some(
      isOwnerGuard(marker.value.kind)
        ? refuseChildGuard({
            db,
            subject,
            current,
            mutations,
            index: marker.value.index,
            kind: marker.value.kind,
          })
        : refuseAttributed({
            db,
            subject,
            current,
            mutations,
            index: marker.value.index,
            kind: marker.value.kind === "budget" ? "audit" : marker.value.kind,
          })
    );
  }
  const detail = String(cause);
  return detail.includes("canonical_child_guard_") ||
    detail.includes("canonical_child_budget_") ||
    detail.includes("canonical_child_movement_") ||
    detail.includes("canonical_child_capacity_")
    ? Option.some(Effect.succeed({ _tag: "Unavailable" } as const))
    : Option.none();
};

/**
 * Attribute an aborted unit only when its indexed CHECK or a known trigger proves the child, then
 * record that child's refusal after rollback. A forged marker or unowned trigger is Unavailable;
 * an unmarked abort stays Aborted so a same-material statement can retry without a false Audit.
 */
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
  mutations: ReadonlyArray<PreparedCanonicalMutation>;
  cause: unknown;
}>): Effect.Effect<CanonicalMutationUnitExecution> =>
  Effect.gen(function* () {
    const live = yield* Effect.tryPromise(() =>
      liveTransactionCredential({ db, subject, current })
    ).pipe(Effect.orElseSucceed(() => false));
    if (!live) return { _tag: "CredentialRefused" } as const;
    const marked = markedAbort({ db, subject, current, mutations, cause });
    if (Option.isSome(marked)) return yield* marked.value;
    const attributed = triggerAttribution({
      mutations,
      detail: String(cause),
    });
    if (Option.isSome(attributed)) {
      return yield* refuseAttributed({
        db,
        subject,
        current,
        mutations,
        index: attributed.value.index,
        kind: attributed.value.kind,
      });
    }
    // No unmarked abort proves a child; leave individual statement replay free to retry a
    // same-material race while all other callers answer unavailable without a refusal Audit.
    return { _tag: "Aborted" } as const;
  });

const findCommittedInsight = ({
  db,
  userId,
  outcome,
}: Readonly<{
  db: D1Database;
  userId: string;
  outcome: Extract<PreparedCanonicalMutation["outcome"], { _tag: "Insight" }>;
}>): Effect.Effect<Option.Option<CommittedMutationValue>> =>
  Effect.gen(function* () {
    const event = yield* findInsight(db, userId, outcome.insightEventId);
    if (Option.isNone(event)) return Option.none<CommittedMutationValue>();
    if (Option.isNone(outcome.attemptId)) {
      return Option.some({ _tag: "Insight" as const, insight: event.value });
    }
    const attempt = yield* findInsightAttempt(db, userId, outcome.insightEventId);
    return Option.map(
      Option.filter(
        attempt,
        (found) => Option.isSome(outcome.attemptId) && found.id === outcome.attemptId.value
      ),
      (deliveryAttempt) => ({
        _tag: "DeliveredInsight" as const,
        insight: event.value,
        deliveryAttempt,
      })
    );
  }).pipe(Effect.orElseSucceed(() => Option.none()));

/** Read one committed child's canonical success value, or None when the readback is incomplete. */
const findCommittedValue = ({
  db,
  userId,
  mutation,
}: Readonly<{
  db: D1Database;
  userId: string;
  mutation: PreparedCanonicalMutation;
}>): Effect.Effect<Option.Option<CommittedMutationValue>> => {
  switch (mutation.outcome._tag) {
    case "Budget":
      return findBudgetValue({ db, userId, outcome: mutation.outcome });
    case "Insight":
      return findCommittedInsight({ db, userId, outcome: mutation.outcome });
    case "Transaction":
      return findTransactionValue({ db, userId, outcome: mutation.outcome });
    case "KeywordRule":
      return findKeywordRuleValue({ db, userId, outcome: mutation.outcome });
    case "Memory":
      return findMemoryValue({ db, userId, outcome: mutation.outcome });
    case "ForwardingAddress":
      return readForwardingAddress(db, userId, mutation.outcome.current).pipe(
        Effect.map(Option.map((address) => ({ _tag: "ForwardingAddress" as const, address })))
      );
    case "StatementSubmission": {
      const statement = mutation.outcome;
      return Effect.gen(function* () {
        const read = readOwnedStatementSubmission(statement.config, {
          userId,
          submissionId: statement.publication.submissionId,
        });
        let result = yield* Effect.exit(read);
        for (let attempt = 1; attempt < 3 && Exit.isFailure(result); attempt += 1) {
          result = yield* Effect.exit(read);
        }
        if (Exit.isFailure(result)) return Option.none();
        return Option.flatMap(result.value, (row) =>
          Option.map(submissionProjection(row), (submission) => ({
            _tag: "StatementSubmission" as const,
            submission,
          }))
        );
      });
    }
  }
};

/** Guard every owner's known commit-time trigger before its write, then assert completion. */
const childStatements = ({
  db,
  subject,
  current,
  mutation,
  index,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  mutation: PreparedCanonicalMutation;
  index: number;
}>): ReadonlyArray<D1PreparedStatement> => {
  const userId = subject.userId;
  const operation = mutationOperation(mutation);
  return [
    ...(mutation.auditBudget === "shared"
      ? [childBudget({ db, userId, current, index, operation })]
      : []),
    ...Option.match(mutation.commitGuards, {
      onNone: (): ReadonlyArray<D1PreparedStatement> => [],
      onSome: (guards) => guards({ db, userId, current, index, operation }),
    }),
    ...mutation.statements,
    childCompletion(db, index, operation),
  ];
};

/**
 * Commit one ordered set of owner-prepared canonical mutations in a single D1 atomic unit and read
 * each committed value back. Each child has its own indexed Audit assertion and a completion assertion;
 * a guard that silently changes no row aborts the whole unit instead of being noticed after a
 * successful commit. The unit never opens a nested D1 unit and never performs provider work; an
 * aborted unit is classified against the same live credential, budgets, and domain premises the
 * individual operations check.
 */
export const executeCanonicalMutationUnit = ({
  db,
  subject,
  current,
  mutations,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  mutations: ReadonlyArray<PreparedCanonicalMutation>;
}>): Effect.Effect<CanonicalMutationUnitExecution> =>
  Effect.uninterruptible(
    Effect.gen(function* () {
      if (mutations.length === 0) return { _tag: "Unavailable" } as const;
      if (mutations.length > maximumAtomicBatchCalls) return { _tag: "Unavailable" } as const;
      const statements = mutations.flatMap((mutation, index) =>
        childStatements({ db, subject, current, mutation, index })
      );
      const attempt = yield* Effect.exit(Effect.tryPromise(() => db.batch(statements)));
      if (Exit.isFailure(attempt)) {
        return yield* classifyAbortedUnit({
          db,
          subject,
          current,
          mutations,
          cause: attempt.cause,
        });
      }
      const values: Array<CommittedMutationValue> = [];
      for (const mutation of mutations) {
        const read = findCommittedValue({ db, userId: subject.userId, mutation });
        let value = yield* read;
        for (let attempt = 1; attempt < 3 && Option.isNone(value); attempt += 1) {
          value = yield* read;
        }
        if (Option.isNone(value)) return { _tag: "Unavailable" } as const;
        values.push(value.value);
      }
      return { _tag: "Committed", values } as const;
    })
  );

/** The JSON payload one committed canonical value carries as its operation's success data. */
export const committedMutationPayload = (value: CommittedMutationValue): unknown => {
  switch (value._tag) {
    case "Transaction":
    case "EffectiveTransaction":
      return value.transaction;
    case "RestoredPair":
      return value.pair;
    case "KeywordRule":
      return value.rule;
    case "Memory":
      return value.memory;
    case "StatementSubmission":
      return value.submission;
    case "ForwardingAddress":
      return value.address;
    case "Budget":
      return value.budget;
    case "Insight":
      return value.insight;
    case "DeliveredInsight":
      return { insight: value.insight, deliveryAttempt: value.deliveryAttempt };
    case "RemovedKeywordRule":
    case "RemovedMemory":
    case "RemovedBudget":
      return value.id;
  }
};

const encodeRemovedValue = (
  value: Extract<
    CommittedMutationValue,
    { _tag: "RemovedBudget" | "RemovedKeywordRule" | "RemovedMemory" }
  >
): Effect.Effect<unknown, Schema.SchemaError> =>
  value._tag === "RemovedKeywordRule"
    ? Schema.encodeEffect(Schema.toCodecJson(KeywordRuleId))(value.id)
    : encodeOtherRemovedValue(value);

const encodeOtherRemovedValue = (
  value: Extract<CommittedMutationValue, { _tag: "RemovedBudget" | "RemovedMemory" }>
): Effect.Effect<unknown, Schema.SchemaError> =>
  value._tag === "RemovedBudget"
    ? Schema.encodeEffect(Schema.toCodecJson(BudgetId))(value.id)
    : Schema.encodeEffect(Schema.toCodecJson(MemoryId))(value.id);

const encodeInsightSubmissionOrMemory = (
  value: Extract<
    CommittedMutationValue,
    { _tag: "Insight" | "DeliveredInsight" | "StatementSubmission" | "Memory" }
  >
): Effect.Effect<unknown, Schema.SchemaError> => {
  if (value._tag === "StatementSubmission") {
    return Schema.encodeEffect(Schema.toCodecJson(StatementSubmission))(value.submission);
  }
  if (value._tag === "Memory") {
    return Schema.encodeEffect(Schema.toCodecJson(Memory))(value.memory);
  }
  return value._tag === "Insight"
    ? Schema.encodeEffect(Schema.toCodecJson(InsightEvent))(value.insight)
    : Schema.encodeEffect(
        Schema.toCodecJson(
          Schema.Struct({
            insight: InsightEvent,
            deliveryAttempt: InsightDeliveryAttempt,
          })
        )
      )(value);
};

const encodeEntityValue = (
  value: Exclude<
    ExistingCommittedValue,
    {
      _tag:
        | "RemovedBudget"
        | "RemovedKeywordRule"
        | "RemovedMemory"
        | "Budget"
        | "Memory"
        | "StatementSubmission"
        | "Insight"
        | "DeliveredInsight";
    }
  >
): Effect.Effect<unknown, Schema.SchemaError> => {
  switch (value._tag) {
    case "Transaction":
      return Schema.encodeEffect(TransactionOutput)(value.transaction);
    case "EffectiveTransaction":
      return Schema.encodeEffect(Schema.toCodecJson(TransactionPresentation))(value.transaction);
    case "RestoredPair":
      return Schema.encodeEffect(Schema.toCodecJson(RestoredTransactionPair))(value.pair);
    case "KeywordRule":
      return Schema.encodeEffect(Schema.toCodecJson(KeywordRule))(value.rule);
  }
};

const encodeExistingValue = (
  value: ExistingCommittedValue
): Effect.Effect<unknown, Schema.SchemaError> => {
  if ("id" in value) return encodeRemovedValue(value);
  if (value._tag === "Budget") return Schema.encodeEffect(Schema.toCodecJson(Budget))(value.budget);
  if ("insight" in value || "submission" in value || "memory" in value) {
    return encodeInsightSubmissionOrMemory(value);
  }
  return encodeEntityValue(value);
};

const encodeCommittedValue = (
  value: CommittedMutationValue
): Effect.Effect<unknown, Schema.SchemaError> =>
  value._tag === "ForwardingAddress"
    ? Schema.encodeEffect(Schema.toCodecJson(EmailForwardingAddress))(value.address)
    : encodeExistingValue(value);

/** Encode one committed value as its canonical individual success response. */
export const committedJsonResponse = ({
  value,
  status,
}: Readonly<{ value: CommittedMutationValue; status: number }>): Effect.Effect<Response> =>
  encodeCommittedValue(value).pipe(
    Effect.map((json) =>
      Response.json({ data: json, next: [] }, { status, headers: transactionNoStore })
    ),
    Effect.orElseSucceed(transactionUnavailable)
  );

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

const singleResponse = ({
  db,
  subject,
  execution,
  present,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  execution: CanonicalMutationUnitExecution;
  present: (value: CommittedMutationValue) => Effect.Effect<Response>;
}>): Effect.Effect<Response> => {
  switch (execution._tag) {
    case "Committed": {
      const [value] = execution.values;
      // A committed single-child unit always reports one value; an empty list is a defect, not a
      // caller-visible refusal, so it dies instead of masquerading as unavailability.
      return value === undefined
        ? Effect.die("A committed canonical unit reported no value")
        : present(value);
    }
    case "Rejected":
      return execution.refusal.respond(execution.disposition);
    case "CredentialRefused":
      return refusedCredentialResponse({ db, subject });
    case "Unavailable":
    case "Aborted":
      return Effect.succeed(transactionUnavailable());
  }
};

type SingleWork = Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  preparation: CanonicalMutationPreparation;
  present: (value: CommittedMutationValue) => Effect.Effect<Response>;
  retryStatement: Option.Option<() => Effect.Effect<CanonicalMutationPreparation>>;
}>;

/** Commit a prepared single mutation, retrying only a proven same-material statement race. */
const executePreparedSingle = ({
  db,
  subject,
  current,
  preparation,
  present,
  retryStatement,
}: SingleWork &
  Readonly<{
    preparation: Extract<CanonicalMutationPreparation, { _tag: "Prepared" }>;
  }>): Effect.Effect<Response> =>
  executeCanonicalMutationUnit({ db, subject, current, mutations: [preparation.mutation] }).pipe(
    Effect.flatMap((execution) => {
      const outcome = preparation.mutation.outcome;
      if (
        execution._tag !== "Aborted" ||
        outcome._tag !== "StatementSubmission" ||
        Option.isNone(retryStatement)
      ) {
        return singleResponse({ db, subject, execution, present });
      }
      return lostStatementReplay(outcome.config, outcome.publication).pipe(
        Effect.flatMap((sameMaterial) =>
          sameMaterial
            ? retryStatement.value().pipe(
                Effect.flatMap((next) =>
                  executeSingleCanonicalMutation({
                    db,
                    subject,
                    current,
                    preparation: next,
                    present,
                    retryStatement: Option.none(),
                  })
                )
              )
            : Effect.succeed(transactionUnavailable())
        )
      );
    })
  );

/**
 * Execute one owner-prepared canonical mutation as its own caller-owned unit and map every outcome
 * to its canonical individual response. This is the individual half of the same implementation the
 * atomic batch composes, so validation, live authority, refusal Audit, and commit classification
 * cannot drift between them.
 */
export const executeSingleCanonicalMutation = ({
  db,
  subject,
  current,
  preparation,
  present,
  retryStatement,
}: SingleWork): Effect.Effect<Response> => {
  switch (preparation._tag) {
    case "Refused":
      // `record` and `respond` never fail by contract; see `rejectChild` for the same guarantee.
      return preparation.refusal.record().pipe(Effect.flatMap(preparation.refusal.respond));
    case "CredentialRefused":
      return refusedCredentialResponse({ db, subject });
    case "Unavailable":
      return Effect.succeed(transactionUnavailable());
    case "Failed":
      return failedPreparationResponse({ db, subject, current });
    case "Prepared":
      return executePreparedSingle({ db, subject, current, preparation, present, retryStatement });
  }
};
