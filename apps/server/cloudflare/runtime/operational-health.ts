import { Clock, Effect, Exit, Option, Schema } from "effect";

const WorkKind = Schema.Literals([
  "onboarding",
  "browserPairing",
  "emailReplacement",
  "billing",
  "statement",
]);
type WorkKind = typeof WorkKind.Type;
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
const Backlog = Schema.Struct({
  backlogCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  backlogBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
const sampleLimit = 8;
const staleAfterMilliseconds = 120_000;
const rejectedWindowMilliseconds = 86_400_000;

/** Closed operational evidence. No identity, provider detail, proof, or financial value is exported. */
type PendingSignal = Readonly<{
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
      operation: "deadLetters";
      state: "healthy" | "attention";
      backlogCount: number;
      backlogBytes: number;
    }>
  | Readonly<{
      component: "async-health";
      operation: WorkKind | "deadLetters";
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
  workflows: Partial<Record<WorkKind, WorkflowStatusBinding>>;
  deadLetters: Option.Option<Pick<Queue, "metrics">>;
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

const pendingQueries: Record<WorkKind, string> = {
  onboarding: `SELECT id, created_at_ms AS created, expires_at_ms AS deadline FROM pending_email_enrollments WHERE state IN ('awaiting_delivery', 'sending', 'ambiguous') ORDER BY created_at_ms LIMIT ?`,
  browserPairing: `SELECT work_id AS id, last_requested_at_ms AS created, expires_at_ms AS deadline FROM browser_pairing_email_proofs WHERE state IN ('awaiting_delivery', 'sending', 'ambiguous') ORDER BY last_requested_at_ms LIMIT ?`,
  emailReplacement: `SELECT work_id AS id, created_at_ms AS created, expires_at_ms AS deadline FROM email_replacements WHERE state IN ('awaiting_delivery', 'sending', 'ambiguous') ORDER BY created_at_ms LIMIT ?`,
  billing: `SELECT id, created_at_ms AS created, NULL AS deadline FROM billing_attempts WHERE status = 'pending' ORDER BY created_at_ms LIMIT ?`,
  statement: `SELECT id, submitted_at_ms AS created, retention_expires_at_ms AS deadline FROM statement_submissions WHERE status IN ('queued', 'processing') ORDER BY submitted_at_ms LIMIT ?`,
};

const rejectedQueries: Partial<Record<WorkKind, string>> = {
  onboarding:
    "SELECT COUNT(*) AS count FROM (SELECT 1 FROM pending_email_enrollments WHERE state = 'rejected' AND created_at_ms >= ? LIMIT ?)",
  browserPairing:
    "SELECT COUNT(*) AS count FROM (SELECT 1 FROM browser_pairing_email_proofs WHERE state = 'rejected' AND last_requested_at_ms >= ? LIMIT ?)",
  emailReplacement:
    "SELECT COUNT(*) AS count FROM (SELECT 1 FROM email_replacements WHERE state = 'rejected' AND created_at_ms >= ? LIMIT ?)",
};
const RejectionCount = Schema.Struct({
  count: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: sampleLimit })),
});

/** The retained rejection state can follow provider refusal or exhausted proof attempts. */
const rejectedEmailWork = (
  environment: OperationalHealthEnvironment,
  operation: WorkKind,
  current: number
): Effect.Effect<number, void> => {
  const query = Option.fromUndefinedOr(rejectedQueries[operation]);
  if (Option.isNone(query)) return Effect.succeed(0);
  return Effect.tryPromise(() =>
    environment.DB.prepare(query.value)
      .bind(current - rejectedWindowMilliseconds, sampleLimit)
      .first()
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

const inspectDeadLetters = (
  queue: Option.Option<Pick<Queue, "metrics">>
): Effect.Effect<OperationalSignal> =>
  Effect.gen(function* () {
    if (Option.isNone(queue)) return unavailableSignal("deadLetters");
    const backlog = yield* Effect.exit(
      Effect.tryPromise(() => queue.value.metrics()).pipe(
        Effect.timeout("2 seconds"),
        Effect.flatMap(Schema.decodeUnknownEffect(Backlog))
      )
    );
    if (Exit.isFailure(backlog)) return unavailableSignal("deadLetters");
    return {
      component: "async-health",
      operation: "deadLetters",
      ...backlog.value,
      state: backlog.value.backlogCount > 0 ? "attention" : "healthy",
    };
  });

const pendingState = (age: number, expired: number, failed: number): "attention" | "healthy" =>
  age >= staleAfterMilliseconds || expired > 0 || failed > 0 ? "attention" : "healthy";

const inspectPending = (
  environment: OperationalHealthEnvironment,
  operation: WorkKind,
  current: number
): Effect.Effect<OperationalSignal> =>
  Effect.gen(function* () {
    const fetched = yield* Effect.exit(
      Effect.tryPromise(() =>
        environment.DB.prepare(pendingQueries[operation]).bind(sampleLimit).all()
      ).pipe(
        Effect.flatMap((rows) => Schema.decodeUnknownEffect(Schema.Array(Pending))(rows.results))
      )
    );
    if (Exit.isFailure(fetched)) return unavailableSignal(operation);
    const rejected = yield* Effect.exit(rejectedEmailWork(environment, operation, current));
    if (Exit.isFailure(rejected)) return unavailableSignal(operation);
    const rows = fetched.value;
    const workflow = Option.fromUndefinedOr(environment.workflows[operation]);
    let failedWorkflows = 0;
    let unavailableWorkflows = 0;
    for (const row of rows) {
      // Fresh work may not have reached a Workflow yet; only inspect stalled identities.
      if (current - row.created < staleAfterMilliseconds) continue;
      const status = yield* inspectWorkflow(workflow, row.id);
      if (status === "unavailable") unavailableWorkflows += 1;
      if (status === "failed") failedWorkflows += 1;
    }
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
      failedWorkflows,
      unavailableWorkflows,
      state: pendingState(
        oldestPendingAgeMilliseconds,
        expiredUndelivered,
        failedWorkflows + rejected.value
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
    const deadLetters = yield* inspectDeadLetters(environment.deadLetters);
    return [...signals, deadLetters];
  });
