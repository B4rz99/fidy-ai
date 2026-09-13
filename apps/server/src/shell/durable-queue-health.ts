import { Duration, Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import {
  type DurableQueueAttention,
  classifyDurableQueueAttention,
  durableQueueLeaseStallSeconds,
  durableQueueLockExpirationSeconds,
  durableQueueNames,
  durableQueueNativeDecodeFailurePrefix,
  durableQueueSchemaIncompatibleMarker,
  durableQueueTableName,
  hasDurableQueueAttention,
  isPermanentDurableQueueAttention,
  isTransientDurableQueueAttention,
  observedMaxAttemptsForDurableQueue,
} from "./durable-queue-policy";
import { runBestEffortMaintenance } from "./maintenance-schedule";
import {
  maximumTelemetryCount,
  maximumTelemetryDurationMilliseconds,
} from "./observability/protocol";
import { type ScheduledWorkDescriptor, runScheduledWork } from "./observability/scheduled-work";
import { Telemetry } from "./observability/telemetry";

const DurableQueueHealthCounts = Schema.Struct({
  pendingDepth: Schema.Int,
  oldestPendingAgeSeconds: Schema.Int,
  retainedCount: Schema.Int,
  oldestRetainedAgeSeconds: Schema.Int,
  activeLeaseCount: Schema.Int,
  staleLeaseCount: Schema.Int,
  stalledLeaseCount: Schema.Int,
  redeliveredCount: Schema.Int,
  failedCount: Schema.Int,
  decodeFailureCount: Schema.Int,
  exhaustedCount: Schema.Int,
});

/**
 * One queue's bounded health counts, derived from the schema that decodes them. The probe never
 * selects `element` or `last_failure` content: every signal is a count, a bounded age, an equality
 * match against the exact `durableQueueSchemaIncompatibleMarker`, or a bounded prefix match against
 * the store's native `SchemaError` rendering, so queue payloads, User identifiers, and failure text
 * cannot enter readiness, logs, or telemetry. Retained history is exposed for observation and never
 * alerts alone.
 */
export type DurableQueueHealth = Readonly<{ readonly queueName: string }> &
  typeof DurableQueueHealthCounts.Type;

const DurableQueueHealthRequest = Schema.Struct({
  queueName: Schema.String,
  maxAttempts: Schema.Int,
  expirySeconds: Schema.Int,
  stallSeconds: Schema.Int,
  schemaMarker: Schema.String,
  decodeFailurePattern: Schema.String,
});

/** One queue's bounded health counts plus its alert flags, the exact readiness shape. */
export type DurableQueueReadinessQueue = DurableQueueHealth &
  Readonly<{ readonly attention: DurableQueueAttention }>;

/** The shared telemetry duration maximum expressed in the whole seconds the age query returns. */
const maximumDurableQueueAgeSeconds = Math.floor(
  Duration.toSeconds(Duration.millis(maximumTelemetryDurationMilliseconds))
);

/** Bounded probe parameters; the decode-failure pattern is a prefix, never failure content. */
const durableQueueHealthParams = (queueName: string): typeof DurableQueueHealthRequest.Type => ({
  queueName,
  maxAttempts: observedMaxAttemptsForDurableQueue(queueName),
  expirySeconds: durableQueueLockExpirationSeconds,
  stallSeconds: durableQueueLeaseStallSeconds,
  schemaMarker: durableQueueSchemaIncompatibleMarker,
  decodeFailurePattern: `${durableQueueNativeDecodeFailurePrefix}%`,
});

/**
 * One indexed aggregate over a single queue. The probe never selects `element` or `last_failure`:
 * pending means eligible (`attempts < maxAttempts`); retained rows are completed history awaiting
 * domain retention; decode failures are rows whose recorded failure is the store's native
 * `SchemaError` rendering or the exact retirement marker; stalled leases missed two refresh
 * intervals while still live (refresh failure); stale leases are held past expiry (refresh failed
 * and stayed failed, or a process died without releasing); redelivered rows carry at least one
 * attempt; exhausted rows have spent their retry budget and will never be reclaimed by polling.
 * Counts are capped at the shared telemetry-count maximum and ages at the shared duration maximum.
 */
const readDurableQueueCounts = (
  sql: SqlClient.SqlClient,
  queueName: string
): Effect.Effect<typeof DurableQueueHealthCounts.Type, never, SqlClient.SqlClient> =>
  SqlSchema.findOne({
    Request: DurableQueueHealthRequest,
    Result: DurableQueueHealthCounts,
    execute: (request) => sql`
      SELECT
        LEAST(count(*) FILTER (
          WHERE completed = FALSE AND attempts < ${request.maxAttempts}
        ), ${maximumTelemetryCount})::int AS "pendingDepth",
        LEAST(GREATEST(COALESCE(EXTRACT(EPOCH FROM (
          now() - min(created_at) FILTER (
            WHERE completed = FALSE AND attempts < ${request.maxAttempts}
          )
        ))::int, 0), 0), ${maximumDurableQueueAgeSeconds}) AS "oldestPendingAgeSeconds",
        LEAST(count(*) FILTER (
          WHERE completed = TRUE
        ), ${maximumTelemetryCount})::int AS "retainedCount",
        LEAST(GREATEST(COALESCE(EXTRACT(EPOCH FROM (
          now() - min(updated_at) FILTER (WHERE completed = TRUE)
        ))::int, 0), 0), ${maximumDurableQueueAgeSeconds}) AS "oldestRetainedAgeSeconds",
        LEAST(count(*) FILTER (
          WHERE completed = FALSE AND acquired_at IS NOT NULL
            AND acquired_at >= now() - ${request.expirySeconds} * interval '1 second'
        ), ${maximumTelemetryCount})::int AS "activeLeaseCount",
        LEAST(count(*) FILTER (
          WHERE completed = FALSE AND acquired_at IS NOT NULL
            AND acquired_at < now() - ${request.expirySeconds} * interval '1 second'
        ), ${maximumTelemetryCount})::int AS "staleLeaseCount",
        LEAST(count(*) FILTER (
          WHERE completed = FALSE AND acquired_at IS NOT NULL
            AND acquired_at < now() - ${request.stallSeconds} * interval '1 second'
            AND acquired_at >= now() - ${request.expirySeconds} * interval '1 second'
        ), ${maximumTelemetryCount})::int AS "stalledLeaseCount",
        LEAST(count(*) FILTER (
          WHERE completed = FALSE AND attempts > 0 AND attempts < ${request.maxAttempts}
        ), ${maximumTelemetryCount})::int AS "redeliveredCount",
        LEAST(count(*) FILTER (
          WHERE completed = FALSE AND last_failure IS NOT NULL
            AND attempts < ${request.maxAttempts}
        ), ${maximumTelemetryCount})::int AS "failedCount",
        LEAST(count(*) FILTER (
          WHERE completed = FALSE AND (
            last_failure = ${request.schemaMarker}
            OR last_failure LIKE ${request.decodeFailurePattern}
          )
        ), ${maximumTelemetryCount})::int AS "decodeFailureCount",
        LEAST(count(*) FILTER (
          WHERE completed = FALSE AND attempts >= ${request.maxAttempts}
        ), ${maximumTelemetryCount})::int AS "exhaustedCount"
      FROM ${sql(durableQueueTableName)} WHERE queue_name = ${request.queueName}
    `,
  })(durableQueueHealthParams(queueName)).pipe(Effect.orDie);

/** Reads one queue's bounded health counts. */
const readDurableQueueHealth = (
  queueName: string
): Effect.Effect<DurableQueueHealth, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const counts = yield* readDurableQueueCounts(sql, queueName);
    return { queueName, ...counts } satisfies DurableQueueHealth;
  });

/**
 * Reads bounded health counts for the given queue names, one indexed aggregate each. Production
 * callers pass the policy's stable names through `getDurableQueueHealth`; tests pass isolated
 * names to avoid touching production queues.
 */
export const getDurableQueueHealthFor = (
  queueNames: ReadonlyArray<string>
): Effect.Effect<ReadonlyArray<DurableQueueHealth>, never, SqlClient.SqlClient> =>
  Effect.forEach(queueNames, readDurableQueueHealth);

/** Reads bounded health counts for every stable production queue name. */
export const getDurableQueueHealth: Effect.Effect<
  ReadonlyArray<DurableQueueHealth>,
  never,
  SqlClient.SqlClient
> = getDurableQueueHealthFor(durableQueueNames);

/** The exact bounded annotations a queue-attention warning may carry. */
export type DurableQueueAttentionLogAnnotations = Readonly<{
  queue_name: string;
  pending_depth: number;
  oldest_pending_age_seconds: number;
  retained_count: number;
  oldest_retained_age_seconds: number;
  active_lease_count: number;
  stale_lease_count: number;
  stalled_lease_count: number;
  redelivered_count: number;
  failed_count: number;
  decode_failure_count: number;
  exhausted_count: number;
  backlog: boolean;
  lease_churn: boolean;
  exhausted: boolean;
  decode_failure: boolean;
}>;

/** Builds the exact bounded annotations a queue-attention warning may carry. */
export const durableQueueAttentionLogAnnotations = (
  queue: DurableQueueReadinessQueue
): DurableQueueAttentionLogAnnotations => ({
  queue_name: queue.queueName,
  pending_depth: queue.pendingDepth,
  oldest_pending_age_seconds: queue.oldestPendingAgeSeconds,
  retained_count: queue.retainedCount,
  oldest_retained_age_seconds: queue.oldestRetainedAgeSeconds,
  active_lease_count: queue.activeLeaseCount,
  stale_lease_count: queue.staleLeaseCount,
  stalled_lease_count: queue.stalledLeaseCount,
  redelivered_count: queue.redeliveredCount,
  failed_count: queue.failedCount,
  decode_failure_count: queue.decodeFailureCount,
  exhausted_count: queue.exhaustedCount,
  backlog: queue.attention.backlog,
  lease_churn: queue.attention.leaseChurn,
  exhausted: queue.attention.exhausted,
  decode_failure: queue.attention.decodeFailure,
});

/**
 * Emits one warning per queue needing attention with only the stable queue name and bounded counts,
 * flags, or ages; never payload bytes, failure text, or User identifiers.
 */
const logDurableQueueAttention = (queue: DurableQueueReadinessQueue): Effect.Effect<void> =>
  Effect.logWarning("Durable queue needs operational attention").pipe(
    Effect.annotateLogs(durableQueueAttentionLogAnnotations(queue))
  );

/**
 * Observes the given queues: warns once per queue needing attention with only stable queue names
 * and bounded counts, then declares one outcome for the probe's span so alerts distinguish
 * transient backlog and lease churn (retryable failure) from permanently ineligible exhausted or
 * schema-incompatible work (non-retryable rejection). Permanent ineligibility outranks coincidental
 * transient signs so the non-retryable alert is never masked. Per-queue attribution stays in the
 * warning logs above and the readiness body; silence means every observed queue is healthy.
 */
export const observeDurableQueueHealthFor = Effect.fn("DurableQueue.observeHealth")(function* (
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
    yield* logDurableQueueAttention({ ...queue, attention });
  }
  if (permanent) {
    yield* telemetry.recordOutcome({
      outcome: "rejected",
      error: Option.some("operational_failure"),
      retryable: false,
    });
  } else if (transient) {
    yield* telemetry.recordOutcome({
      outcome: "failed",
      error: Option.some("operational_failure"),
      retryable: true,
    });
  }
  return queues;
});

/** Observes every stable production queue name. */
export const observeDurableQueueHealth: Effect.Effect<
  ReadonlyArray<DurableQueueHealth>,
  never,
  Telemetry | SqlClient.SqlClient
> = observeDurableQueueHealthFor(durableQueueNames);

/** Schedule identity shared by the production probe and the tests that exercise its alert path. */
export const durableQueueHealthSchedule = {
  component: "postgres",
  schedule: "task.durableQueueHealth",
  operationalError: "operational_failure",
} satisfies ScheduledWorkDescriptor;

/** Minutely best-effort health probe; a missed tick only delays visibility and never stops work. */
const probeDurableQueueHealth = observeDurableQueueHealth.pipe(
  runScheduledWork(durableQueueHealthSchedule),
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

/** Bounded readiness report: one entry per stable queue name, with no aggregate gate. */
export type DurableQueueReadiness = Readonly<{
  readonly queues: ReadonlyArray<DurableQueueReadinessQueue>;
}>;

/**
 * Projects health counts into the exact shape allowed to leave the process. The projection
 * constructs each field from counts and flags, so payload bytes, failure text, and User
 * identifiers cannot ride along.
 */
export const projectDurableQueueReadiness = (
  queues: ReadonlyArray<DurableQueueHealth>
): DurableQueueReadiness => ({
  queues: queues.map((queue) => ({
    queueName: queue.queueName,
    pendingDepth: queue.pendingDepth,
    oldestPendingAgeSeconds: queue.oldestPendingAgeSeconds,
    retainedCount: queue.retainedCount,
    oldestRetainedAgeSeconds: queue.oldestRetainedAgeSeconds,
    activeLeaseCount: queue.activeLeaseCount,
    staleLeaseCount: queue.staleLeaseCount,
    stalledLeaseCount: queue.stalledLeaseCount,
    redeliveredCount: queue.redeliveredCount,
    failedCount: queue.failedCount,
    decodeFailureCount: queue.decodeFailureCount,
    exhaustedCount: queue.exhaustedCount,
    attention: classifyDurableQueueAttention(queue),
  })),
});

/**
 * Unauthenticated read-only readiness report for the shared queue store. A successful read returns
 * 200 with one entry per stable queue name carrying bounded counts and alert flags; the report
 * deliberately has no aggregate gate, so the minutely probe declares the alert outcome and
 * orchestrators decide traffic policy from the body. Transient backlog and lease churn stay
 * retryable; exhausted and schema-incompatible work does not. A storage failure is an error
 * response, never a fabricated queue state.
 */
export const DurableQueueReadinessLive = HttpRouter.add(
  "GET",
  "/readiness/durable-queues",
  Effect.flatMap(getDurableQueueHealth, (queues) =>
    HttpServerResponse.json(projectDurableQueueReadiness(queues))
  )
);
