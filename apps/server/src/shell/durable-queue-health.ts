import { Duration, Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import {
  type DurableQueueAttention,
  classifyDurableQueueAttention,
  durableQueueLeaseStallSeconds,
  durableQueueLockExpirationSeconds,
  durableQueueNames,
  durableQueueSchemaIncompatibleMarker,
  durableQueueTableName,
  hasDurableQueueAttention,
  isPermanentDurableQueueAttention,
  isTransientDurableQueueAttention,
  maxAttemptsForDurableQueue,
} from "./durable-queue-policy";
import { runBestEffortMaintenance } from "./maintenance-schedule";
import {
  maximumTelemetryCount,
  maximumTelemetryDurationMilliseconds,
} from "./observability/protocol";
import { runScheduledWork } from "./observability/scheduled-work";
import { Telemetry } from "./observability/telemetry";

/**
 * Bounded per-queue health counts. The probe never selects `element` or `last_failure` content:
 * every signal is a count, a bounded age, or an equality match against the exact
 * `durableQueueSchemaIncompatibleMarker`, so queue payloads, User identifiers, and failure text
 * cannot enter readiness, logs, or telemetry. Native schema decode failures are counted as failed
 * and redelivered rows; only work retired as schema-incompatible carries the exact marker.
 */
export type DurableQueueHealth = Readonly<{
  readonly queueName: string;
  readonly pendingDepth: number;
  readonly oldestPendingAgeSeconds: number;
  readonly activeLeaseCount: number;
  readonly staleLeaseCount: number;
  readonly stalledLeaseCount: number;
  readonly redeliveredCount: number;
  readonly failedCount: number;
  readonly schemaIncompatibleCount: number;
  readonly exhaustedCount: number;
}>;

const DurableQueueHealthRequest = Schema.Struct({
  queueName: Schema.String,
  maxAttempts: Schema.Int,
  expirySeconds: Schema.Int,
  stallSeconds: Schema.Int,
  schemaMarker: Schema.String,
});

const DurableQueueHealthCounts = Schema.Struct({
  pendingDepth: Schema.Int,
  oldestPendingAgeSeconds: Schema.Int,
  activeLeaseCount: Schema.Int,
  staleLeaseCount: Schema.Int,
  stalledLeaseCount: Schema.Int,
  redeliveredCount: Schema.Int,
  failedCount: Schema.Int,
  schemaIncompatibleCount: Schema.Int,
  exhaustedCount: Schema.Int,
});

/** The shared telemetry duration maximum expressed in the whole seconds the age query returns. */
const maximumDurableQueueAgeSeconds = Math.floor(
  Duration.toSeconds(Duration.millis(maximumTelemetryDurationMilliseconds))
);

/**
 * Reads one queue's bounded health counts. Pending means eligible (`attempts < maxAttempts`);
 * stalled leases missed two refresh intervals while still live (refresh failure); stale leases are
 * held past expiry (refresh failed and stayed failed, or a process died without releasing);
 * redelivered rows carry at least one attempt; exhausted rows have spent their retry budget and
 * will never be reclaimed by polling. Counts are capped at the shared telemetry-count maximum and
 * ages at the shared duration maximum.
 */
const readDurableQueueHealth = (
  queueName: string
): Effect.Effect<DurableQueueHealth, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const queueTable = sql(durableQueueTableName);
    const counts = yield* SqlSchema.findOne({
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
            WHERE completed = FALSE AND last_failure = ${request.schemaMarker}
          ), ${maximumTelemetryCount})::int AS "schemaIncompatibleCount",
          LEAST(count(*) FILTER (
            WHERE completed = FALSE AND attempts >= ${request.maxAttempts}
          ), ${maximumTelemetryCount})::int AS "exhaustedCount"
        FROM ${queueTable} WHERE queue_name = ${request.queueName}
      `,
    })({
      queueName,
      maxAttempts: maxAttemptsForDurableQueue(queueName),
      expirySeconds: durableQueueLockExpirationSeconds,
      stallSeconds: durableQueueLeaseStallSeconds,
      schemaMarker: durableQueueSchemaIncompatibleMarker,
    }).pipe(Effect.orDie);
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
export const durableQueueAttentionLogAnnotations = (input: {
  readonly queue: DurableQueueHealth;
  readonly attention: DurableQueueAttention;
}): Readonly<Record<string, string | number | boolean>> => ({
  queue_name: input.queue.queueName,
  pending_depth: input.queue.pendingDepth,
  oldest_pending_age_seconds: input.queue.oldestPendingAgeSeconds,
  active_lease_count: input.queue.activeLeaseCount,
  stale_lease_count: input.queue.staleLeaseCount,
  stalled_lease_count: input.queue.stalledLeaseCount,
  redelivered_count: input.queue.redeliveredCount,
  failed_count: input.queue.failedCount,
  schema_incompatible_count: input.queue.schemaIncompatibleCount,
  exhausted_count: input.queue.exhaustedCount,
  backlog: input.attention.backlog,
  lease_churn: input.attention.leaseChurn,
  exhausted: input.attention.exhausted,
  decode_failure: input.attention.decodeFailure,
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
    Effect.annotateLogs(durableQueueAttentionLogAnnotations({ queue, attention }))
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
    yield* logDurableQueueAttention(queue, attention);
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

/** Minutely best-effort health probe; a missed tick only delays visibility and never stops work. */
const probeDurableQueueHealth = observeDurableQueueHealth.pipe(
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

/**
 * Unauthenticated readiness report for the shared queue store. The surface is deliberately
 * read-only and always returns 200: every condition it reports is either retryable or does not
 * affect new work, so gating traffic belongs to the operator alerting path (the minutely probe and
 * its declared outcome) rather than to this body. `status` is "needs-attention" while any observed
 * queue has attention, and every queue carries its own bounded flags.
 */
export const DurableQueueReadinessLive = HttpRouter.add(
  "GET",
  "/readiness/durable-queues",
  Effect.flatMap(getDurableQueueHealth, (queues) =>
    HttpServerResponse.json(projectDurableQueueReadiness(queues))
  )
);
