import { inspectWhatsApp } from "../../whatsapp/operations";
import {
  type AlertSignal,
  type CanaryHealth,
  CanaryPayload,
  type CapabilityProbe,
  type EventMetricSignal,
  type OperationalAlert,
  type OperationalAlertDelivery,
  type OperationalHealthEnvironment,
  type OperationalSignal,
  QueueKind,
  WorkKind,
  coordinatorProbeName,
} from "./contract";
import {
  inspectPending,
  inspectQueue,
  inspectRetention,
  unavailableSignal,
} from "./internal/health-inspection";
import { asyncAlerts } from "./internal/alert-policy";
import { deliverD1Outage } from "./internal/d1-outage-alert";
import { claimResolutions, deliverFiring, deliverResolution } from "./internal/alert-delivery";
import {
  WorkflowFailureCounts,
  bucketRetentionMs,
  fiveMinuteWindowMs,
  maximumSweepRows,
  recentWindowMs,
  unavailableMetrics,
} from "./internal/event-metrics";
import { Clock, Effect, Exit, Option, Schema } from "effect";
import { Check, WorkflowStatus, periodMs, recordCanary, staleMs } from "./internal/canary";

const Available = Schema.Struct({ usable: Schema.Literal(1) });
const probeUrl = "https://internal.invalid/operational/probe";
const probeSuccessStatus = 204;
const alertDeliveryConcurrency = 2;

/** An actual Queue consumer, not queue.send(), proves Queue execution. */
export const receiveCanary = (
  input: Readonly<{
    DB: D1Database;
    workflow: Readonly<{
      create: (input: { id: string; params: CanaryPayload }) => Promise<unknown>;
      get: (id: string) => Promise<{ status: () => Promise<unknown> }>;
    }>;
    payload: unknown;
    now: number;
  }>
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(CanaryPayload)(input.payload);
      if (
        Option.isNone(decoded) ||
        decoded.value.sentAtMs > input.now ||
        input.now - decoded.value.sentAtMs > staleMs
      ) {
        return yield* Effect.die(new Error("Invalid operational canary"));
      }
      yield* recordCanary({ db: input.DB, kind: "queueExecution", now: input.now });
      const id = `operational-canary-${Math.floor(decoded.value.sentAtMs / periodMs)}`;
      const created = yield* Effect.exit(
        Effect.tryPromise(() => input.workflow.create({ id, params: decoded.value }))
      );
      if (Exit.isFailure(created)) {
        // A redelivery may race a successful handoff; only a confirmed existing instance is safe.
        const instance = yield* Effect.tryPromise(() => input.workflow.get(id)).pipe(
          Effect.catch(() => Effect.failCause(created.cause))
        );
        const status = yield* Effect.tryPromise(() => instance.status()).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(WorkflowStatus))
        );
        if (
          status.status === "errored" ||
          status.status === "terminated" ||
          status.status === "unknown"
        ) {
          return yield* Effect.failCause(created.cause);
        }
      }
    })
  );

/** Only a completed Workflow step proves Workflow execution. */
export const completeCanary = ({
  db,
  payload,
  now,
}: Readonly<{
  db: D1Database;
  payload: unknown;
  now: number;
}>): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const decoded = Schema.decodeUnknownOption(CanaryPayload)(payload);
      if (
        Option.isNone(decoded) ||
        decoded.value.sentAtMs > now ||
        now - decoded.value.sentAtMs > staleMs
      ) {
        return yield* Effect.die(new Error("Invalid operational canary"));
      }
      yield* recordCanary({ db, kind: "workflowExecution", now });
    })
  );

/** Inspect private D1 evidence; absent/invalid state never becomes a healthy measurement. */
export const readCanaryHealth = ({
  db,
  now,
}: Readonly<{
  db: D1Database;
  now: number;
}>): Promise<ReadonlyArray<CanaryHealth>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const operations: ReadonlyArray<CanaryHealth["operation"]> = [
        "queueExecution",
        "workflowExecution",
      ];
      const rows = yield* Effect.exit(
        Effect.tryPromise(() =>
          db.prepare("SELECT kind, last_succeeded_ms FROM operational_canary").all()
        ).pipe(
          Effect.flatMap((response) =>
            Schema.decodeUnknownEffect(Schema.Array(Check))(response.results)
          )
        )
      );
      if (Exit.isFailure(rows)) {
        return operations.map((operation): CanaryHealth => ({
          component: "capability",
          operation,
          state: "unavailable",
        }));
      }
      return operations.map((operation): CanaryHealth => {
        const row = rows.value.find((item) => item.kind === operation);
        if (row === undefined) return { component: "capability", operation, state: "unavailable" };
        return {
          component: "capability",
          operation,
          state: now - row.last_succeeded_ms <= staleMs ? "healthy" : "attention",
          lastSucceededMs: row.last_succeeded_ms,
        };
      });
    })
  );

/** Sending is not success; missing Workflows and Queue delivery remain visible until a real completion. */
export const sendCanary = ({
  queue,
  now,
  signal,
}: Readonly<{
  queue: Pick<Queue, "send">;
  now: number;
  signal: AbortSignal;
}>): Promise<void> => {
  const sentAtMs = Math.floor(now / periodMs) * periodMs;
  return Effect.runPromise(
    Effect.tryPromise(() => queue.send({ version: 1, sentAtMs } satisfies CanaryPayload)).pipe(
      // Queue.send has no cancellation API. Stop waiting without retrying an ambiguous offer.
      Effect.timeout("2 seconds"),
      Effect.asVoid
    ),
    { signal }
  );
};

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
      WorkKind.literals.filter(
        (kind) =>
          kind !== "proactivity" ||
          environment.proactivity.weeklyEnabled === true ||
          environment.proactivity.proactivityEnabled === true
      ),
      (operation) =>
        inspectPending({ environment, operation, current }).pipe(
          Effect.timeout("3 seconds"),
          Effect.orElseSucceed((): OperationalSignal => unavailableSignal(operation))
        ),
      { concurrency: 2 }
    );
    const whatsapp = yield* inspectWhatsApp({ db: environment.DB, current }).pipe(
      Effect.timeout("3 seconds"),
      Effect.orElseSucceed((): OperationalSignal => unavailableSignal("whatsapp"))
    );
    const deadLetters = yield* inspectQueue({
      operation: "deadLetters",
      queue: environment.deadLetters,
    });
    const workQueues = yield* Effect.forEach(
      QueueKind.literals.filter(
        (kind) =>
          kind !== "proactivityQueue" ||
          environment.proactivity.weeklyEnabled === true ||
          environment.proactivity.proactivityEnabled === true
      ),
      (operation) =>
        inspectQueue({
          operation,
          queue: Option.fromUndefinedOr(environment.workQueues[operation]),
        }),
      { concurrency: 2 }
    );
    const retention = yield* inspectRetention({ db: environment.DB, now: current });
    return [...signals, whatsapp, deadLetters, ...workQueues, retention];
  });

/** Classifies already-bounded inspection results; unavailable is never interpreted as zero. */
export const decideOperationalAlerts = (
  signals: ReadonlyArray<AlertSignal>
): ReadonlyArray<OperationalAlert> =>
  signals.flatMap((signal): ReadonlyArray<OperationalAlert> => {
    if (signal.state === "unavailable") {
      return [{ kind: "inspection_unavailable", owner: signal.operation, severity: "warning" }];
    }
    if (signal.component === "workflow-execution") {
      return signal.recentCount > 0
        ? [{ kind: "workflow_failure", owner: signal.operation, severity: "critical" }]
        : [];
    }
    if (signal.component === "capability") {
      return signal.state === "attention"
        ? [{ kind: "capability_unusable", owner: signal.operation, severity: "critical" }]
        : [];
    }
    return asyncAlerts(signal);
  });

const isD1Outage = (alert: OperationalAlert): boolean =>
  alert.kind === "inspection_unavailable" && alert.owner === "d1";

const d1Severity = (alert: Option.Option<OperationalAlert>): OperationalAlert["severity"] =>
  Option.match(alert, { onNone: () => "warning", onSome: (value) => value.severity });

/** Claims metadata-only email attempts atomically. Failed sends remain unconfirmed. */
export const runOperationalAlerts = (input: OperationalAlertDelivery): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const outageAlert = Option.fromUndefinedOr(input.alerts.find(isD1Outage));
      const unavailable = Option.isSome(outageAlert);
      if (Option.isSome(input.outage)) {
        const outageWork = deliverD1Outage({
          ...input,
          outageBucket: input.outage.value.bucket,
          release: input.outage.value.release,
          inspection: unavailable ? "unavailable" : input.outage.value.inspection,
          severity: d1Severity(outageAlert),
        });
        yield* unavailable ? outageWork : outageWork.pipe(Effect.orElseSucceed(() => undefined));
        if (unavailable) return;
      }
      const attempts = yield* Effect.forEach(
        input.alerts,
        (alert) => deliverFiring({ input, alert }),
        {
          concurrency: alertDeliveryConcurrency,
        }
      );
      const rows = yield* claimResolutions(input);
      const resolutions = yield* Effect.forEach(rows, (row) => deliverResolution({ input, row }), {
        concurrency: alertDeliveryConcurrency,
      });
      if (attempts.includes(false) || resolutions.includes(false)) {
        return yield* Effect.die(new Error("Operator alert email unavailable"));
      }
    }),
    { signal: input.signal }
  );

/** Bounded expiry prevents operational event buckets from growing indefinitely. */
export const sweepOperationalEventBuckets = ({
  db,
  now,
}: Readonly<{
  db: D1Database;
  now: number;
}>): Effect.Effect<void, void> =>
  Effect.tryPromise(() =>
    db
      .prepare(`DELETE FROM operational_event_buckets
  WHERE rowid IN (SELECT rowid FROM operational_event_buckets WHERE bucket_ms < ? LIMIT ?)`)
      .bind(now - bucketRetentionMs, maximumSweepRows)
      .run()
  ).pipe(
    Effect.timeout("2 seconds"),
    Effect.asVoid,
    Effect.mapError(() => undefined)
  );

/** Inspects directly recorded Workflow failures; an unreadable D1 measurement is unavailable. */
export const observeOperationalEventMetrics = ({
  db,
  now,
}: Readonly<{
  db: D1Database;
  now: number;
}>): Effect.Effect<ReadonlyArray<EventMetricSignal>> =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      Effect.tryPromise(() =>
        db
          .prepare(`SELECT
        COALESCE(SUM(count), 0) AS recentCount,
        COALESCE(SUM(CASE WHEN bucket_ms >= ? THEN count ELSE 0 END), 0) AS fiveMinuteCount
        FROM operational_event_buckets
        WHERE kind = 'workflow_failure' AND bucket_ms >= ? AND bucket_ms <= ?`)
          .bind(now - fiveMinuteWindowMs, now - recentWindowMs, now)
          .first()
      ).pipe(
        Effect.timeout("2 seconds"),
        Effect.flatMap((row) => Schema.decodeUnknownEffect(WorkflowFailureCounts)(row))
      )
    );
    if (Exit.isFailure(result)) return unavailableMetrics();
    const { recentCount, fiveMinuteCount } = result.value;
    return [
      {
        component: "workflow-execution",
        operation: "workflowFailures",
        state: recentCount > 0 ? "attention" : "healthy",
        recentCount,
        fiveMinuteCount,
      },
    ];
  });

/** Latest private, metadata-only inspection; timestamps make stale observations visible. */
export const recordOperationalHealth = ({
  db,
  signals,
  observedAtMs,
}: Readonly<{
  db: D1Database;
  signals: ReadonlyArray<AlertSignal>;
  observedAtMs: number;
}>): Promise<void> =>
  Effect.runPromise(
    Effect.tryPromise(() =>
      db.batch(
        signals.map((signal) =>
          db
            .prepare(`INSERT INTO operational_health_view
    (operation, state, observed_at_ms) VALUES (?, ?, ?)
    ON CONFLICT(operation) DO UPDATE SET state = excluded.state,
      observed_at_ms = excluded.observed_at_ms WHERE excluded.observed_at_ms >= observed_at_ms`)
            .bind(signal.operation, signal.state, observedAtMs)
        )
      )
    ).pipe(Effect.asVoid)
  );

/** Private readiness evidence; configuration means present, not that an external provider succeeded. */
export const inspectOperationalCapabilities = (
  input: Readonly<{
    d1: Readonly<{ prepare: (sql: string) => { first: () => Promise<unknown> } }>;
    coordinator: Readonly<{
      getByName: (name: string) => { fetch: (request: Request) => Promise<Response> };
    }>;
    requiredBindings: ReadonlyArray<boolean>;
    providerConfigured: boolean;
  }>
): Effect.Effect<ReadonlyArray<CapabilityProbe>> =>
  Effect.gen(function* () {
    const d1 = yield* Effect.exit(
      Effect.tryPromise(() => input.d1.prepare("SELECT 1 AS usable").first()).pipe(
        Effect.timeout("2 seconds"),
        Effect.flatMap(Schema.decodeUnknownEffect(Available))
      )
    );
    const coordination = yield* Effect.exit(
      Effect.tryPromise((signal) =>
        input.coordinator.getByName(coordinatorProbeName).fetch(new Request(probeUrl, { signal }))
      ).pipe(Effect.timeout("2 seconds"))
    );
    const status = (ready: boolean): CapabilityProbe["state"] =>
      ready ? "healthy" : "unavailable";
    return [
      { component: "capability", operation: "d1", state: status(Exit.isSuccess(d1)) },
      {
        component: "capability",
        operation: "requiredBindings",
        state: status(input.requiredBindings.every(Boolean)),
      },
      {
        component: "capability",
        operation: "coordination",
        state: status(
          Exit.isSuccess(coordination) && coordination.value.status === probeSuccessStatus
        ),
      },
      {
        component: "capability",
        operation: "providerConfig",
        state: status(input.providerConfigured),
      },
    ];
  });

const minuteMs = 60_000;
const maximumBucketCount = 1_000;

/** Best-effort failure evidence never replaces a Workflow's original success or rejection. */
export const captureWorkflowFailure = <A>({
  work,
  db,
}: Readonly<{
  work: Promise<A>;
  db: D1Database;
}>): Promise<A> =>
  work.catch((original: unknown) =>
    Effect.runPromise(
      Effect.gen(function* () {
        const bucket = Math.floor((yield* Clock.currentTimeMillis) / minuteMs) * minuteMs;
        yield* Effect.exit(
          Effect.tryPromise(() =>
            db
              .prepare(`INSERT INTO operational_event_buckets (kind, bucket_ms, count)
        VALUES ('workflow_failure', ?, 1)
        ON CONFLICT(kind, bucket_ms) DO UPDATE SET count = MIN(count + 1, ?)`)
              .bind(bucket, maximumBucketCount)
              .run()
          ).pipe(Effect.timeout("250 millis"))
        );
      })
    ).then(() => Promise.reject(original))
  );
