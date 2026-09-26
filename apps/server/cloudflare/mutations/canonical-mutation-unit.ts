import { Effect, Exit, Option, Schema } from "effect";
import {
  KeywordRule,
  KeywordRuleId,
  KeywordRuleLimitReached,
  maximumKeywordRulesPerUser,
} from "@fidy/server/categories";
import { Memory, MemoryId, type MemoryOperationId } from "@fidy/server/memory-runtime";
import { Budget, BudgetId } from "@fidy/server/budgets-runtime";
import { InsightDeliveryAttempt, InsightEvent } from "@fidy/server/insights-runtime";
import { findInsight, findInsightAttempt, insightRefusal } from "../insights/insight-store";
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
  statementAbortRefusal,
  submissionProjection,
} from "../ingestion/statement-staging";
import { canonicalStatementRefusal } from "./statement-mutation";
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
import {
  findKeywordRuleValue,
  keywordRuleAbortFailure,
  keywordRuleBudgetRefusal,
  keywordRuleCapacityIndex,
  keywordRuleRefusal,
} from "./keyword-rule-outcome";
import {
  findMemoryValue,
  findOwnedMemory,
  memoryBudgetRefusal,
  memoryCapacityIndex,
  memoryRefusal,
} from "./memory-outcome";
import {
  findTransactionValue,
  transactionAbortRefusal,
  transactionBudgetRefusal,
  transactionMovementIndex,
  transactionMovementRefusal,
  transactionRefusal,
} from "./transaction-outcome";
import type {
  CanonicalMutationPreparation,
  CanonicalMutationRefusal,
  CommittedMutationValue,
  MemoryOutcome,
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
type TriggerKind = "movement" | "capacity" | "audit";

/**
 * A shared Audit budget trigger identifies its owner only in a single-child unit. A recount after
 * rollback can include unrelated commits and cannot safely select a child of a mixed batch.
 */
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

const budgetTriggerRefusal = (kind: TriggerKind): Option.Option<CanonicalMutationRefusal> =>
  kind === "audit" ? Option.some(budgetAuditLimitRefusal()) : Option.none();

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
  switch (mutation.outcome._tag) {
    case "Budget":
    case "Insight":
    case "ForwardingAddress":
    case "StatementSubmission":
      return metadataTriggerRefusal(mutation.outcome._tag, kind);
    case "Transaction":
      return transactionTriggerRefusal({
        db,
        subject: scoped,
        current,
        outcome: mutation.outcome,
        kind,
      });
    case "KeywordRule":
      return keywordRuleTriggerRefusal(scoped, kind);
    case "Memory":
      return memoryTriggerRefusal({
        db,
        subject: scoped,
        current,
        operation: mutation.outcome.operation,
        kind,
      });
  }
};

const metadataTriggerRefusal = (
  owner: "Budget" | "Insight" | "ForwardingAddress" | "StatementSubmission",
  kind: TriggerKind
): Option.Option<CanonicalMutationRefusal> => {
  if (owner === "Budget" || owner === "Insight") return budgetTriggerRefusal(kind);
  return kind === "audit" ? Option.some(nonTransactionAuditLimitRefusal(owner)) : Option.none();
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
  return kind === "audit" ? Option.some(transactionBudgetRefusal()) : Option.none();
};

/** The refusal a keyword-rule child reports for a trigger that belongs to its own owner. */
const keywordRuleTriggerRefusal = (
  subject: TransactionCaller,
  kind: TriggerKind
): Option.Option<CanonicalMutationRefusal> => {
  if (kind === "capacity") {
    return Option.some(
      keywordRuleRefusal({
        failure: new KeywordRuleLimitReached({ maximum: maximumKeywordRulesPerUser }),
        subject,
      })
    );
  }
  return kind === "audit" ? Option.some(keywordRuleBudgetRefusal()) : Option.none();
};

/** The refusal a Memory child reports for a trigger that belongs to its own owner. */
const memoryTriggerRefusal = ({
  db,
  subject,
  current,
  operation,
  kind,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  operation: MemoryOperationId;
  kind: TriggerKind;
}>): Option.Option<CanonicalMutationRefusal> => {
  if (kind === "capacity") {
    return Option.some(
      memoryRefusal({ db, subject, operation, outcome: "resource_limit", current })
    );
  }
  return kind === "audit" ? Option.some(memoryBudgetRefusal()) : Option.none();
};

/** True when a correction child repeats an observed revision an earlier child already advanced. */
const markObservedRevision = (observed: Set<string>, outcome: TransactionOutcome): boolean => {
  if (Option.isNone(outcome.expectedRevision)) return false;
  const key = `${outcome.transactionId}:${outcome.expectedRevision.value}`;
  const seen = observed.has(key);
  observed.add(key);
  return seen;
};

/** The refusal one Transaction child explains after the unit rolled back, or None. */
const transactionInferredRefusal = ({
  db,
  subject,
  current,
  outcome,
  repeated,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  outcome: TransactionOutcome;
  repeated: boolean;
}>): Effect.Effect<Option.Option<CanonicalMutationRefusal>> =>
  transactionAbortRefusal({
    db,
    userId: subject.userId,
    outcome,
    repeated,
  }).pipe(
    Effect.map(
      Option.map((refusal) =>
        transactionRefusal({
          db,
          subject,
          operation: outcome.operation,
          refusal,
          current,
        })
      )
    )
  );

/** The refusal one Memory child explains after the unit rolled back, or None. */
const memoryInferredRefusal = ({
  db,
  subject,
  current,
  outcome,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  outcome: MemoryOutcome;
}>): Effect.Effect<Option.Option<CanonicalMutationRefusal>> => {
  if (outcome.operation === "memory.remember") return Effect.succeedNone;
  return findOwnedMemory({ db, userId: subject.userId, id: outcome.memoryId }).pipe(
    Effect.map((owns) =>
      Option.flatMap(owns, (owned) =>
        owned
          ? Option.none()
          : Option.some(
              memoryRefusal({
                db,
                subject,
                operation: outcome.operation,
                outcome: "not_found",
                current,
              })
            )
      )
    )
  );
};

const inferredInsightRefusal = ({
  db,
  subject,
  current,
  outcome,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  outcome: Extract<PreparedCanonicalMutation["outcome"], { _tag: "Insight" }>;
}>): Effect.Effect<Option.Option<CanonicalMutationRefusal>> =>
  findInsight(db, subject.userId, outcome.insightEventId).pipe(
    Effect.map((event) =>
      Option.some(
        insightRefusal({
          db,
          subject,
          current,
          operation: outcome.operation,
          code: Option.isNone(event) ? "not_found" : "validation_failed",
        })
      )
    )
  );

/**
 * The refusal one prepared child explains after the unit rolled back, or None when the committed
 * state cannot prove it responsible. Transaction children replay their observed revision and pair
 * premises, keyword-rule children replay their own rule conflicts, and Memory children prove the
 * addressed row is no longer theirs.
 */
const inferredAbortRefusal = ({
  db,
  subject,
  current,
  mutation,
  observed,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  mutation: PreparedCanonicalMutation;
  observed: Set<string>;
}>): Effect.Effect<Option.Option<CanonicalMutationRefusal>> => {
  const outcome = mutation.outcome;
  const scoped = childCaller(subject, mutation.requiredScope);
  switch (outcome._tag) {
    case "Budget":
      return Effect.succeedNone;
    case "Insight":
      return inferredInsightRefusal({ db, subject: scoped, current, outcome });
    case "Transaction":
      return transactionInferredRefusal({
        db,
        subject: scoped,
        current,
        outcome,
        repeated: markObservedRevision(observed, outcome),
      });
    case "KeywordRule":
      return keywordRuleAbortFailure({ db, userId: subject.userId, outcome }).pipe(
        Effect.map(Option.map((failure) => keywordRuleRefusal({ failure, subject: scoped })))
      );
    case "Memory":
      return memoryInferredRefusal({ db, subject: scoped, current, outcome });
    case "ForwardingAddress":
      return Effect.succeedNone;
    case "StatementSubmission":
      return statementAbortRefusal(outcome.config, outcome.publication).pipe(
        Effect.map(
          Option.map((refusal) =>
            canonicalStatementRefusal({
              config: outcome.config,
              subject: scoped,
              current,
              refusal,
            })
          )
        )
      );
  }
};

const inferredAbortIndex = ({
  db,
  subject,
  current,
  mutations,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  mutations: ReadonlyArray<PreparedCanonicalMutation>;
}>): Effect.Effect<Option.Option<Readonly<{ index: number; refusal: CanonicalMutationRefusal }>>> =>
  Effect.gen(function* () {
    const observed = new Set<string>();
    for (const [index, mutation] of mutations.entries()) {
      const refusal = yield* inferredAbortRefusal({
        db,
        subject,
        current,
        mutation,
        observed,
      });
      if (Option.isSome(refusal)) return Option.some({ index, refusal: refusal.value });
    }
    return Option.none();
  });

/**
 * One child index an attribution read produced, or None when the read fails or the unit holds no
 * child the trigger can blame — never an index borrowed from another owner.
 */
const attributedIndex = <E>(
  attempt: Effect.Effect<Option.Option<number>, E>
): Effect.Effect<Option.Option<number>> => attempt.pipe(Effect.option, Effect.map(Option.flatten));

/**
 * The child index and trigger class one aborted unit's D1 constraint names, or None when the
 * message is not a known commit-time trigger or no child in the unit can be named as its cause.
 * The value attributes an abort; the triggers themselves remain the atomic authority that admitted
 * or refused the work.
 */
const triggerAttribution = ({
  db,
  subject,
  current,
  mutations,
  detail,
}: Readonly<{
  db: D1Database;
  subject: TransactionCaller;
  current: number;
  mutations: ReadonlyArray<PreparedCanonicalMutation>;
  detail: string;
}>): Effect.Effect<Option.Option<Readonly<{ index: number; kind: TriggerKind }>>> =>
  Effect.gen(function* () {
    const trigger = canonicalTriggerOf(detail);
    if (Option.isNone(trigger)) return Option.none();
    // Every declared trigger name is matched here, so a new one must name the child class it
    // blames or this build fails.
    switch (trigger.value) {
      case canonicalTriggerNames.resourceLimit: {
        const index = yield* attributedIndex(
          transactionMovementIndex({ db, userId: subject.userId, current, mutations })
        );
        return Option.map(index, (value) => ({ index: value, kind: "movement" as const }));
      }
      case canonicalTriggerNames.keywordRuleLimit: {
        const index = yield* attributedIndex(
          keywordRuleCapacityIndex({ db, userId: subject.userId, mutations })
        );
        return Option.map(index, (value) => ({ index: value, kind: "capacity" as const }));
      }
      case canonicalTriggerNames.memoryCapacity: {
        const index = yield* attributedIndex(
          memoryCapacityIndex({ db, subject, current, mutations })
        );
        return Option.map(index, (value) => ({ index: value, kind: "capacity" as const }));
      }
      case canonicalTriggerNames.auditLimit: {
        const index = auditBudgetIndex(mutations);
        return Option.map(index, (value) => ({ index: value, kind: "audit" as const }));
      }
    }
  });

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

/**
 * Attribute one aborted unit to the first child the committed state or its trigger message proves
 * responsible, then record that child's refusal evidence. The unit rolled back, so no child state
 * and no child success AuditLogEntry exists; a refusal it cannot attribute answers `Unavailable`.
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
    const attributed = yield* triggerAttribution({
      db,
      subject,
      current,
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
    const inferred = yield* inferredAbortIndex({ db, subject, current, mutations });
    if (Option.isSome(inferred)) {
      return yield* rejectRecorded({
        callIndex: inferred.value.index,
        refusal: inferred.value.refusal,
      });
    }
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
  });

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

/**
 * Commit one ordered set of owner-prepared canonical mutations in a single D1 atomic unit and read
 * each committed value back. Every mutation is followed by its owner's completion assertion, so a
 * guard that silently changes no row aborts the whole unit instead of being noticed after a
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
      const statements = mutations.flatMap((mutation) => [
        ...mutation.statements,
        mutation.completion,
      ]);
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

type ExistingCommittedValue = Exclude<CommittedMutationValue, { _tag: "ForwardingAddress" }>;

type LegacyPayloadValue = Exclude<
  ExistingCommittedValue,
  { _tag: "Budget" | "Insight" | "DeliveredInsight" }
>;
const existingMutationPayload = (value: LegacyPayloadValue): unknown => {
  if ("transaction" in value) return value.transaction;
  if ("submission" in value) return value.submission;
  if ("pair" in value) return value.pair;
  if ("rule" in value) return value.rule;
  if ("memory" in value) return value.memory;
  return value.id;
};

/** The JSON payload one committed canonical value carries as its operation's success data. */
export const committedMutationPayload = (value: CommittedMutationValue): unknown => {
  if (value._tag === "ForwardingAddress") return value.address;
  if (value._tag === "Budget") return value.budget;
  if (value._tag === "Insight") return value.insight;
  if (value._tag === "DeliveredInsight") {
    return { insight: value.insight, deliveryAttempt: value.deliveryAttempt };
  }
  return existingMutationPayload(value);
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

const encodeNotificationValue = (
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
    return encodeNotificationValue(value);
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
