import { Clock, Effect, Exit, Option, Schema } from "effect";
import { type EmailWorkOperation } from "../email-authentication/contract";
import {
  prepareEmailPendingWorkObservation,
  prepareEmailRejectedWorkObservation,
} from "../email-authentication/operations";
import {
  prepareIngestionPendingWorkObservation,
  prepareIngestionRetentionObservation,
} from "../ingestion/operations";
import { prepareBillingWorkObservation } from "../subscription/operations";
import { inspectWhatsApp } from "../whatsapp/operations";

const WorkKind = Schema.Literals([
  "onboarding",
  "browserPairing",
  "emailReplacement",
  "billing",
  "statement",
  "forwardedEmail",
]);
type WorkKind = typeof WorkKind.Type;
const QueueKind = Schema.Literals([
  "onboardingQueue",
  "browserPairingQueue",
  "emailReplacementQueue",
  "billingQueue",
  "statementQueue",
  "forwardedEmailQueue",
  "whatsappQueue",
]);
type QueueKind = typeof QueueKind.Type;
const Pending = Schema.Struct({
  id: Schema.String.check(Schema.isUUID()),
  created: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  deadline: Schema.OptionFromNullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
const Status = Schema.Struct({
  status: Schema.Literals([
    "queued",
    "running",
    "paused",
    "errored",
    "terminated",
    "complete",
    "waiting",
    "waitingForPause",
    "unknown",
  ]),
});
const Retained = Schema.Struct({ expires: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) });
const Backlog = Schema.Struct({
  backlogCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  backlogBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const sampleLimit = 8;
const staleAfterMilliseconds = 120_000;
const retentionWarningAgeMs = 3_600_000;
const rejectedWindowMilliseconds = 86_400_000;

/** Closed operational evidence. No identity, provider detail, proof, or financial value is exported. */
export type PendingSignal = Readonly<{
  component: "async-health";
  operation: WorkKind;
  state: "healthy" | "attention";
  sampledRejectedEmailWork: number;
  rejectionSampleLimited: boolean;
  sampledPending: number;
  sampleLimited: boolean;
  oldestPendingAgeMilliseconds: number;
  expiredUndelivered: number;
  failedWorkflows: number;
  unavailableWorkflows: number;
}>;

/** Unavailable measurements carry no invented zeroes; Queue totals are distinct from D1 samples. */
export type OperationalSignal =
  | PendingSignal
  | Readonly<{
      component: "async-health";
      operation: "deadLetters" | QueueKind;
      state: "healthy" | "attention";
      backlogCount: number;
      backlogBytes: number;
    }>
  | Readonly<{
      component: "async-health";
      operation: "whatsapp";
      state: "healthy" | "attention";
      sampledPending: number;
      sampledFailed: number;
      overdueCleanup: number;
      sampleLimited: boolean;
      oldestPendingAgeMilliseconds: number;
    }>
  | Readonly<{
      component: "async-health";
      operation: "retention";
      state: "healthy" | "attention";
      sampledOverdue: number;
      sampleLimited: boolean;
      oldestOverdueAgeMilliseconds: number;
    }>
  | Readonly<{
      component: "async-health";
      operation: WorkKind | QueueKind | "whatsapp" | "deadLetters" | "retention";
      state: "unavailable";
    }>;

const unavailableSignal = (operation: OperationalSignal["operation"]): OperationalSignal => ({
  component: "async-health",
  operation,
  state: "unavailable",
});

type WorkflowStatusBinding = Readonly<{
  get: (id: string) => Promise<{ status: () => Promise<unknown> }>;
}>;
/** Private bindings used only for bounded metadata inspection, never replay or provider calls. */
export type OperationalHealthEnvironment = Readonly<{
  DB: D1Database;
  workflows: Partial<Record<Exclude<WorkKind, "forwardedEmail">, WorkflowStatusBinding>>;
  deadLetters: Option.Option<Pick<Queue, "metrics">>;
  workQueues: Partial<Record<QueueKind, Pick<Queue, "metrics">>>;
}>;

const emptySignal = (operation: WorkKind): PendingSignal => ({
  component: "async-health",
  operation,
  state: "healthy",
  sampledRejectedEmailWork: 0,
  rejectionSampleLimited: false,
  sampledPending: 0,
  sampleLimited: false,
  oldestPendingAgeMilliseconds: 0,
  expiredUndelivered: 0,
  failedWorkflows: 0,
  unavailableWorkflows: 0,
});

const isEmailWork = (operation: WorkKind): operation is EmailWorkOperation =>
  operation === "onboarding" || operation === "browserPairing" || operation === "emailReplacement";
const RejectionCount = Schema.Struct({
  count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: sampleLimit })),
});

/** The retained rejection state can follow provider refusal or exhausted proof attempts. */
const rejectedEmailWork = (
  environment: OperationalHealthEnvironment,
  operation: WorkKind,
  current: number
): Effect.Effect<number, void> => {
  if (!isEmailWork(operation)) return Effect.succeed(0);
  return Effect.tryPromise(() =>
    prepareEmailRejectedWorkObservation({
      db: environment.DB,
      operation,
      sinceMs: current - rejectedWindowMilliseconds,
      limit: sampleLimit,
    }).first()
  ).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(RejectionCount)),
    Effect.map((row) => row.count),
    Effect.mapError(() => undefined)
  );
};

const inspectWorkflow = (
  workflow: Option.Option<WorkflowStatusBinding>,
  id: string
): Effect.Effect<"available" | "failed" | "unavailable"> =>
  Effect.gen(function* () {
    if (Option.isNone(workflow)) return "unavailable";
    const status = yield* Effect.exit(
      Effect.tryPromise(() => workflow.value.get(id).then((instance) => instance.status())).pipe(
        Effect.timeout("2 seconds"),
        Effect.flatMap(Schema.decodeUnknownEffect(Status))
      )
    );
    if (Exit.isFailure(status) || status.value.status === "unknown") return "unavailable";
    return ["errored", "terminated", "paused"].includes(status.value.status)
      ? "failed"
      : "available";
  });

const inspectRetention = (db: D1Database, now: number): Effect.Effect<OperationalSignal> =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      Effect.tryPromise(() =>
        prepareIngestionRetentionObservation({ db, now, limit: sampleLimit }).all()
      ).pipe(
        Effect.timeout("2 seconds"),
        Effect.flatMap((rows) => Schema.decodeUnknownEffect(Schema.Array(Retained))(rows.results))
      )
    );
    if (Exit.isFailure(result)) return unavailableSignal("retention");
    const oldestOverdueAgeMilliseconds = Math.max(
      0,
      ...result.value.map((row) => now - row.expires)
    );
    return {
      component: "async-health",
      operation: "retention",
      state: oldestOverdueAgeMilliseconds >= retentionWarningAgeMs ? "attention" : "healthy",
      sampledOverdue: result.value.length,
      sampleLimited: result.value.length === sampleLimit,
      oldestOverdueAgeMilliseconds,
    };
  });

const inspectQueue = (
  operation: QueueKind | "deadLetters",
  queue: Option.Option<Pick<Queue, "metrics">>
): Effect.Effect<OperationalSignal> =>
  Effect.gen(function* () {
    if (Option.isNone(queue)) return unavailableSignal(operation);
    const backlog = yield* Effect.exit(
      Effect.tryPromise(() => queue.value.metrics()).pipe(
        Effect.timeout("2 seconds"),
        Effect.flatMap(Schema.decodeUnknownEffect(Backlog))
      )
    );
    if (Exit.isFailure(backlog)) return unavailableSignal(operation);
    return {
      component: "async-health",
      operation,
      ...backlog.value,
      state: backlog.value.backlogCount > 0 ? "attention" : "healthy",
    };
  });

const pendingState = (age: number, expired: number, failed: number): "attention" | "healthy" =>
  age >= staleAfterMilliseconds || expired > 0 || failed > 0 ? "attention" : "healthy";

const inspectPendingWorkflow = ({
  environment,
  operation,
  rows,
  current,
}: Readonly<{
  environment: OperationalHealthEnvironment;
  operation: WorkKind;
  rows: ReadonlyArray<typeof Pending.Type>;
  current: number;
}>): Effect.Effect<Readonly<{ failed: number; unavailable: number }>> =>
  Effect.gen(function* () {
    if (operation === "forwardedEmail") return { failed: 0, unavailable: 0 };
    const workflow = Option.fromUndefinedOr(environment.workflows[operation]);
    let failed = 0;
    let unavailable = 0;
    for (const row of rows) {
      if (current - row.created < staleAfterMilliseconds) continue;
      const status = yield* inspectWorkflow(workflow, row.id);
      if (status === "unavailable") unavailable += 1;
      if (status === "failed") failed += 1;
    }
    return { failed, unavailable };
  });

const pendingWorkStatement = (db: D1Database, operation: WorkKind): D1PreparedStatement => {
  if (operation === "billing") return prepareBillingWorkObservation({ db, limit: sampleLimit });
  if (isEmailWork(operation)) {
    return prepareEmailPendingWorkObservation({ db, operation, limit: sampleLimit });
  }
  return prepareIngestionPendingWorkObservation({ db, operation, limit: sampleLimit });
};

const inspectPending = (
  environment: OperationalHealthEnvironment,
  operation: WorkKind,
  current: number
): Effect.Effect<OperationalSignal> =>
  Effect.gen(function* () {
    const fetched = yield* Effect.exit(
      Effect.tryPromise(() => pendingWorkStatement(environment.DB, operation).all()).pipe(
        Effect.flatMap((rows) => Schema.decodeUnknownEffect(Schema.Array(Pending))(rows.results))
      )
    );
    if (Exit.isFailure(fetched)) return unavailableSignal(operation);
    const rejected = yield* Effect.exit(rejectedEmailWork(environment, operation, current));
    if (Exit.isFailure(rejected)) return unavailableSignal(operation);
    const rows = fetched.value;
    // Fresh work may not have reached a Workflow yet; inspect only stalled instances.
    const workflowStates = yield* inspectPendingWorkflow({ environment, operation, rows, current });
    const oldestPendingAgeMilliseconds = Math.max(0, ...rows.map((row) => current - row.created));
    const expiredUndelivered = rows.filter(
      (row) => Option.isSome(row.deadline) && row.deadline.value <= current
    ).length;
    return {
      ...emptySignal(operation),
      sampledRejectedEmailWork: rejected.value,
      rejectionSampleLimited: rejected.value === sampleLimit,
      sampledPending: rows.length,
      sampleLimited: rows.length === sampleLimit,
      oldestPendingAgeMilliseconds,
      expiredUndelivered,
      failedWorkflows: workflowStates.failed,
      unavailableWorkflows: workflowStates.unavailable,
      state: pendingState(
        oldestPendingAgeMilliseconds,
        expiredUndelivered,
        workflowStates.failed + rejected.value
      ),
    };
  });

/**
 * Inspect a bounded oldest-work sample per owner and the dead-letter backlog. An unavailable
 * monitor reports its own closed signal without masking the other owners or changing domain work.
 * Workflow error messages and outputs are never retained. Counts are samples, not global totals.
 */
export const observeOperationalHealth = (
  environment: OperationalHealthEnvironment
): Effect.Effect<ReadonlyArray<OperationalSignal>> =>
  Effect.gen(function* () {
    const current = yield* Clock.currentTimeMillis;
    const signals = yield* Effect.forEach(
      WorkKind.literals,
      (operation) =>
        inspectPending(environment, operation, current).pipe(
          Effect.timeout("3 seconds"),
          Effect.orElseSucceed((): OperationalSignal => unavailableSignal(operation))
        ),
      { concurrency: 2 }
    );
    const whatsapp = yield* inspectWhatsApp({ db: environment.DB, current }).pipe(
      Effect.timeout("3 seconds"),
      Effect.orElseSucceed((): OperationalSignal => unavailableSignal("whatsapp"))
    );
    const deadLetters = yield* inspectQueue("deadLetters", environment.deadLetters);
    const workQueues = yield* Effect.forEach(
      QueueKind.literals,
      (operation) =>
        inspectQueue(operation, Option.fromUndefinedOr(environment.workQueues[operation])),
      { concurrency: 2 }
    );
    const retention = yield* inspectRetention(environment.DB, current);
    return [...signals, whatsapp, deadLetters, ...workQueues, retention];
  });
