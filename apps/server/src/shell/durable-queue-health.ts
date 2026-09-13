import { Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import {
  type DurableQueueAttention,
  classifyDurableQueueAttention,
  durableQueueLockExpirationSeconds,
  durableQueueNames,
  durableQueueSchemaIncompatibleMarker,
  hasDurableQueueAttention,
  isPermanentDurableQueueAttention,
  isTransientDurableQueueAttention,
  maxAttemptsForDurableQueue,
} from "./durable-queue-policy";
import { runBestEffortMaintenance } from "./maintenance-schedule";
import { runScheduledWork } from "./observability/scheduled-work";
import { Telemetry } from "./observability/telemetry";

/**
 * Bounded per-queue health counts. The probe never selects `element` or `last_failure` content:
 * every signal is a count, a bounded age, or an equality match against the exact
 * `durableQueueSchemaIncompatibleMarker`, so queue payloads, User identifiers, and failure text
 * cannot enter readiness, logs, or telemetry.
 */
export type DurableQueueHealth = Readonly<{
  readonly queueName: string;
  readonly pendingDepth: number;
  readonly oldestPendingAgeSeconds: number;
  readonly activeLeaseCount: number;
  readonly staleLeaseCount: number;
  readonly redeliveredCount: number;
  readonly failedCount: number;
  readonly schemaIncompatibleCount: number;
  readonly exhaustedCount: number;
}>;

const DurableQueueHealthRequest = Schema.Struct({
  queueName: Schema.String,
  maxAttempts: Schema.Int,
  expirySeconds: Schema.Int,
  schemaMarker: Schema.String,
});

const DurableQueueHealthCounts = Schema.Struct({
  pendingDepth: Schema.Int,
  oldestPendingAgeSeconds: Schema.Int,
  activeLeaseCount: Schema.Int,
  staleLeaseCount: Schema.Int,
  redeliveredCount: Schema.Int,
  failedCount: Schema.Int,
  schemaIncompatibleCount: Schema.Int,
  exhaustedCount: Schema.Int,
});

/**
 * Reads one queue's bounded health counts. Pending means eligible (`attempts < maxAttempts`);
 * stale leases are held past expiry without refresh (refresh failure or process loss); redelivered
 * rows carry at least one attempt; exhausted rows have spent their retry budget and will never be
 * reclaimed by polling. Counts are capped at the shared telemetry-count maximum and ages at the
 * shared duration maximum.
 */
const readDurableQueueHealth = Effect.fn("DurableQueue.readHealth")(function* (queueName: string) {
  const sql = yield* SqlClient.SqlClient;
  const counts = yield* SqlSchema.findOne({
    Request: DurableQueueHealthRequest,
    Result: DurableQueueHealthCounts,
    execute: (request) => sql`
      SELECT
        LEAST(count(*) FILTER (
          WHERE completed = FALSE AND attempts < ${request.maxAttempts}
        ), 1000000)::int AS "pendingDepth",
        LEAST(GREATEST(COALESCE(EXTRACT(EPOCH FROM (
          now() - min(created_at) FILTER (
            WHERE completed = FALSE AND attempts < ${request.maxAttempts}
          )
        ))::int, 0), 0), 86400000) AS "oldestPendingAgeSeconds",
        LEAST(count(*) FILTER (
          WHERE completed = FALSE AND acquired_at IS NOT NULL
            AND acquired_at >= now() - ${request.expirySeconds} * interval '1 second'
        ), 1000000)::int AS "activeLeaseCount",
        LEAST(count(*) FILTER (
          WHERE completed = FALSE AND acquired_at IS NOT NULL
            AND acquired_at < now() - ${request.expirySeconds} * interval '1 second'
        ), 1000000)::int AS "staleLeaseCount",
        LEAST(count(*) FILTER (
          WHERE completed = FALSE AND attempts > 0 AND attempts < ${request.maxAttempts}
        ), 1000000)::int AS "redeliveredCount",
        LEAST(count(*) FILTER (
          WHERE completed = FALSE AND last_failure IS NOT NULL
            AND attempts < ${request.maxAttempts}
        ), 1000000)::int AS "failedCount",
        LEAST(count(*) FILTER (
          WHERE completed = FALSE AND last_failure = ${request.schemaMarker}
        ), 1000000)::int AS "schemaIncompatibleCount",
        LEAST(count(*) FILTER (
          WHERE completed = FALSE AND attempts >= ${request.maxAttempts}
        ), 1000000)::int AS "exhaustedCount"
      FROM fidy_queue WHERE queue_name = ${request.queueName}
    `,
  })({
    queueName,
    maxAttempts: maxAttemptsForDurableQueue(queueName),
    expirySeconds: durableQueueLockExpirationSeconds,
    schemaMarker: durableQueueSchemaIncompatibleMarker,
  }).pipe(Effect.orDie);
  return { queueName, ...counts } satisfies DurableQueueHealth;
});

/**
 * Reads bounded health counts for the given queue names, one indexed aggregate each. Production
 * callers pass the policy's stable names through `getDurableQueueHealth`; tests pass isolated
 * names to avoid touching production queues.
 */
export const getDurableQueueHealthFor = Effect.fn("DurableQueue.getHealthFor")(function* (
  queueNames: ReadonlyArray<string>
) {
  return yield* Effect.forEach(queueNames, readDurableQueueHealth);
});

/** Reads bounded health counts for every stable production queue name. */
export const getDurableQueueHealth = Effect.fn("DurableQueue.getHealth")(function* () {
  return yield* getDurableQueueHealthFor(durableQueueNames);
});

/**
 * Emits one warning per queue needing attention with only the stable queue name and bounded counts,
 * flags, or ages; never payload bytes, failure text, or User identifiers.
 */
const logDurableQueueAttention = (
  queue: DurableQueueHealth,
  attention: DurableQueueAttention
): Effect.Effect<void> =>
  Effect.logWarning("Durable queue needs operational attention").pipe(
    Effect.annotateLogs({
      queue_name: queue.queueName,
      pending_depth: queue.pendingDepth,
      oldest_pending_age_seconds: queue.oldestPendingAgeSeconds,
      active_lease_count: queue.activeLeaseCount,
      stale_lease_count: queue.staleLeaseCount,
      redelivered_count: queue.redeliveredCount,
      failed_count: queue.failedCount,
      schema_incompatible_count: queue.schemaIncompatibleCount,
      exhausted_count: queue.exhaustedCount,
      backlog: attention.backlog,
      lease_churn: attention.leaseChurn,
      exhausted: attention.exhausted,
      decode_failure: attention.decodeFailure,
    })
  );

/**
 * Observes the given queues: warns once per queue needing attention with only stable queue names
 * and bounded counts, then declares one outcome so alerts distinguish transient backlog and lease
 * churn (retryable failure) from permanently ineligible exhausted or schema-incompatible work
 * (non-retryable rejection). Silence means every observed queue is healthy.
 */
export const observeDurableQueueHealthFor = Effect.fn("DurableQueue.observeHealthFor")(function* (
  queueNames: ReadonlyArray<string>
) {
  const queues = yield* getDurableQueueHealthFor(queueNames);
  const telemetry = yield* Telemetry;
  let transient = false;
  let permanent = false;
  for (const queue of queues) {
    const attention = classifyDurableQueueAttention(queue);
    if (!hasDurableQueueAttention(attention)) continue;
    if (isTransientDurableQueueAttention(attention)) transient = true;
    if (isPermanentDurableQueueAttention(attention)) permanent = true;
    yield* logDurableQueueAttention(queue, attention);
  }
  if (transient) {
    yield* telemetry.recordOutcome({
      outcome: "failed",
      error: Option.some("operational_failure"),
      retryable: true,
    });
  } else if (permanent) {
    yield* telemetry.recordOutcome({
      outcome: "rejected",
      error: Option.some("operational_failure"),
      retryable: false,
    });
  }
  return queues;
});

/** Observes every stable production queue name. */
export const observeDurableQueueHealth = Effect.fn("DurableQueue.observeHealth")(function* () {
  return yield* observeDurableQueueHealthFor(durableQueueNames);
});

/** Minutely best-effort health probe; a missed tick only delays visibility and never stops work. */
const probeDurableQueueHealth = observeDurableQueueHealth().pipe(
  runScheduledWork({
    component: "postgres",
    schedule: "task.durableQueueHealth",
    operationalError: "operational_failure",
  }),
  Effect.ignoreCause
);

/** Best-effort durable-queue health scheduling; authoritative retry budgets stay in the store. */
export const DurableQueueHealthMaintenanceLive = Layer.effectDiscard(
  runBestEffortMaintenance({
    timing: "best-effort",
    cadence: "1 minute",
    work: probeDurableQueueHealth,
  }).pipe(Effect.forkScoped)
);

/** One queue's bounded health counts plus its alert flags, the exact readiness shape. */
export type DurableQueueReadinessQueue = DurableQueueHealth &
  Readonly<{ readonly attention: DurableQueueAttention }>;

/** Bounded readiness projection: overall status plus one entry per stable queue name. */
export type DurableQueueReadiness = Readonly<{
  readonly status: "ok" | "needs-attention";
  readonly queues: ReadonlyArray<DurableQueueReadinessQueue>;
}>;

/**
 * Projects health counts into the exact shape allowed to leave the process. The projection
 * constructs each field from counts and flags, so payload bytes, failure text, and User
 * identifiers cannot ride along.
 */
export const projectDurableQueueReadiness = (
  queues: ReadonlyArray<DurableQueueHealth>
): DurableQueueReadiness => {
  const projected = queues.map((queue) => ({
    ...queue,
    attention: classifyDurableQueueAttention(queue),
  }));
  return {
    status: projected.some((queue) => hasDurableQueueAttention(queue.attention))
      ? "needs-attention"
      : "ok",
    queues: projected,
  };
};

/** Response status while every observed queue is healthy and orchestration keeps routing traffic. */
const durableQueueReadinessOkStatus = 200;

/** Response status while any observed queue needs attention; orchestration holds new traffic. */
const durableQueueReadinessNeedsAttentionStatus = 503;

/**
 * Unauthenticated readiness surface for the shared queue store. It reports 503 while any queue
 * needs attention so orchestration can hold traffic, and its body carries only stable queue names
 * with bounded counts and flags.
 */
export const DurableQueueReadinessLive = HttpRouter.add(
  "GET",
  "/readiness/durable-queues",
  Effect.flatMap(getDurableQueueHealth(), (queues) => {
    const readiness = projectDurableQueueReadiness(queues);
    return HttpServerResponse.json(readiness, {
      status:
        readiness.status === "ok"
          ? durableQueueReadinessOkStatus
          : durableQueueReadinessNeedsAttentionStatus,
    });
  })
);
