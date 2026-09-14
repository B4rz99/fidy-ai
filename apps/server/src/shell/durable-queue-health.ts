import { Duration, Effect, Layer, Option, Redacted, Ref, Schema } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";
import { SqlClient, SqlSchema } from "effect/unstable/sql";
import { serviceUnavailableStatus, unauthorizedStatus } from "~/shell/_shared/http-status";
import {
  maximumStatementIngestionAttempts,
  statementIngestionQueueName,
} from "~/shell/ingestion/worker";
import {
  maximumTelemetryCount,
  maximumTelemetryDurationMilliseconds,
} from "~/shell/observability/protocol";
import {
  type ScheduledWorkDescriptor,
  runScheduledWork,
} from "~/shell/observability/scheduled-work";
import { applicationPersistedQueueNames } from "~/shell/_shared/persisted-queue";
import { Telemetry } from "~/shell/observability/telemetry";
import { SupportAccessVerifier } from "~/shell/recovery/access";
import {
  DurableQueueAttention,
  DurableQueueName,
  classifyDurableQueueAttention,
  durableQueueDefaultMaxAttempts,
  durableQueueLeaseStallSeconds,
  durableQueueLockExpirationSeconds,
  durableQueueNativeDecodeFailurePrefix,
  durableQueueNativeJsonFailurePrefix,
  durableQueueSchemaIncompatibleMarker,
  durableQueueTableName,
  hasDurableQueueAttention,
  isPermanentDurableQueueAttention,
  isTransientDurableQueueAttention,
} from "./durable-queue-policy";
import { runBestEffortMaintenance } from "./maintenance-schedule";

const durableQueueHealthCountFields = {
  pendingDepth: Schema.Int,
  oldestPendingAgeSeconds: Schema.Int,
  retainedCount: Schema.Int,
  oldestRetainedAgeSeconds: Schema.Int,
  activeLeaseCount: Schema.Int,
  staleLeaseCount: Schema.Int,
  stalledLeaseCount: Schema.Int,
  redeliveryCount: Schema.Int,
  failedCount: Schema.Int,
  decodeFailureCount: Schema.Int,
  exhaustedCount: Schema.Int,
};

const DurableQueueHealthCounts = Schema.Struct(durableQueueHealthCountFields);

/** One production queue's bounded health signals. */
export const DurableQueueHealth = Schema.Struct({
  queueName: DurableQueueName,
  ...durableQueueHealthCountFields,
});
export type DurableQueueHealth = typeof DurableQueueHealth.Type;

/** Public bounded readiness report for the shared queue store. */
export const DurableQueueReadiness = Schema.Struct({
  queues: Schema.Array(
    Schema.Struct({
      queueName: DurableQueueName,
      ...durableQueueHealthCountFields,
      attention: DurableQueueAttention,
    })
  ),
});
export type DurableQueueReadiness = typeof DurableQueueReadiness.Type;
export type DurableQueueReadinessQueue = DurableQueueReadiness["queues"][number];

const durableQueueReadinessSnapshot = Ref.makeUnsafe<DurableQueueReadiness>({ queues: [] });

const DurableQueueHealthRequest = Schema.Struct({
  queueName: Schema.String,
  maxAttempts: Schema.Int,
  expirySeconds: Schema.Int,
  stallSeconds: Schema.Int,
  schemaMarker: Schema.String,
  decodeFailurePattern: Schema.String,
  jsonFailurePattern: Schema.String,
});

/** The shared telemetry duration maximum expressed in the whole seconds the age query returns. */
const maximumDurableQueueAgeSeconds = Math.floor(
  Duration.toSeconds(Duration.millis(maximumTelemetryDurationMilliseconds))
);

/** Bounded probe parameters; decode-failure patterns are prefixes, never failure content. */
const durableQueueHealthParams = (
  queueName: DurableQueueName
): typeof DurableQueueHealthRequest.Type => ({
  queueName,
  maxAttempts:
    queueName === statementIngestionQueueName
      ? maximumStatementIngestionAttempts
      : durableQueueDefaultMaxAttempts,
  expirySeconds: durableQueueLockExpirationSeconds,
  stallSeconds: durableQueueLeaseStallSeconds,
  schemaMarker: durableQueueSchemaIncompatibleMarker,
  decodeFailurePattern: `${durableQueueNativeDecodeFailurePrefix}%`,
  jsonFailurePattern: `${durableQueueNativeJsonFailurePrefix}%`,
});

/**
 * One indexed aggregate over a single queue. The probe never selects `element` or `last_failure`:
 * pending means eligible (`attempts < maxAttempts`); retained rows are completed history awaiting
 * domain retention; decode failures are rows whose recorded failure is the store's native
 * `SchemaError` or JSON `SyntaxError` rendering, or the exact retirement marker; stalled leases
 * missed two refresh intervals while still live (refresh failure); stale leases are held past
 * expiry (refresh failed and stayed failed, or a process died without releasing); redelivery is
 * the cumulative number of acquisitions after each row's first acquisition; exhausted rows have
 * spent their retry budget and will never be reclaimed by polling.
 * Counts are capped at the shared telemetry-count maximum and ages at the shared duration maximum.
 */
const readDurableQueueCounts = (
  sql: SqlClient.SqlClient,
  queueName: DurableQueueName
): Effect.Effect<typeof DurableQueueHealthCounts.Type, never, SqlClient.SqlClient> =>
  SqlSchema.findOne({
    Request: DurableQueueHealthRequest,
    Result: DurableQueueHealthCounts,
    execute: (request) => sql`
      SELECT
        LEAST(count(*) FILTER (
          WHERE completed = FALSE AND attempts < ${request.maxAttempts}
            AND (acquired_at IS NULL
              OR acquired_at < now() - ${request.expirySeconds} * interval '1 second')
        ), ${maximumTelemetryCount})::int AS "pendingDepth",
        LEAST(GREATEST(COALESCE(EXTRACT(EPOCH FROM (
          now() - min(created_at) FILTER (
            WHERE completed = FALSE AND attempts < ${request.maxAttempts}
              AND (acquired_at IS NULL
                OR acquired_at < now() - ${request.expirySeconds} * interval '1 second')
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
        LEAST(COALESCE(sum(GREATEST(acquisition_count - 1, 0)), 0),
          ${maximumTelemetryCount})::int AS "redeliveryCount",
        LEAST(count(*) FILTER (
          WHERE completed = FALSE AND last_failure IS NOT NULL
            AND attempts < ${request.maxAttempts}
        ), ${maximumTelemetryCount})::int AS "failedCount",
        LEAST(count(*) FILTER (
          WHERE completed = FALSE AND (
            last_failure = ${request.schemaMarker}
            OR last_failure LIKE ${request.decodeFailurePattern}
            OR last_failure LIKE ${request.jsonFailurePattern}
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
  queueName: DurableQueueName
): Effect.Effect<DurableQueueHealth, never, SqlClient.SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const counts = yield* readDurableQueueCounts(sql, queueName);
    return { queueName, ...counts } satisfies DurableQueueHealth;
  });

/** Reads bounded health counts for the selected production queues. */
export const getDurableQueueHealthFor = (
  queueNames: ReadonlyArray<DurableQueueName>
): Effect.Effect<ReadonlyArray<DurableQueueHealth>, never, SqlClient.SqlClient> =>
  Effect.forEach(queueNames, readDurableQueueHealth);

const readApplicationQueueNames = Effect.sync(applicationPersistedQueueNames);

/** Reads bounded health counts for every application queue constructed in this process. */
export const getDurableQueueHealth: Effect.Effect<
  ReadonlyArray<DurableQueueHealth>,
  never,
  SqlClient.SqlClient
> = readApplicationQueueNames.pipe(Effect.flatMap(getDurableQueueHealthFor));

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
  redelivery_count: number;
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
  redelivery_count: queue.redeliveryCount,
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
const logDurableQueueHealth = (queue: DurableQueueReadinessQueue): Effect.Effect<void> => {
  const message = "Durable queue health";
  const log = hasDurableQueueAttention(queue.attention)
    ? Effect.logWarning(message)
    : Effect.logInfo(message);
  return log.pipe(Effect.annotateLogs(durableQueueAttentionLogAnnotations(queue)));
};

/** Records operational attention for the selected production queues. */
export const observeDurableQueueHealthFor = Effect.fn("DurableQueue.observeHealth")(function* (
  queueNames: ReadonlyArray<DurableQueueName>
) {
  const queues = yield* getDurableQueueHealthFor(queueNames);
  const telemetry = yield* Telemetry;
  let transient = false;
  let permanent = false;
  for (const queue of queues) {
    const attention = classifyDurableQueueAttention(queue);
    if (isTransientDurableQueueAttention(attention)) transient = true;
    if (isPermanentDurableQueueAttention(attention)) permanent = true;
    yield* logDurableQueueHealth({ ...queue, attention });
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

/** Observes every application queue constructed in this process. */
export const observeDurableQueueHealth: Effect.Effect<
  ReadonlyArray<DurableQueueHealth>,
  never,
  Telemetry | SqlClient.SqlClient
> = readApplicationQueueNames.pipe(Effect.flatMap(observeDurableQueueHealthFor));

/** Projects health signals into the public readiness contract. */
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
    redeliveryCount: queue.redeliveryCount,
    failedCount: queue.failedCount,
    decodeFailureCount: queue.decodeFailureCount,
    exhaustedCount: queue.exhaustedCount,
    attention: classifyDurableQueueAttention(queue),
  })),
});

/** Stable scheduled-work identity for the queue health probe. */
export const durableQueueHealthSchedule = {
  component: "postgres",
  schedule: "task.durableQueueHealth",
  operationalError: "operational_failure",
} satisfies ScheduledWorkDescriptor;

/** Minutely best-effort health probe; a missed tick only delays visibility and never stops work. */
const probeDurableQueueHealth = Effect.gen(function* () {
  const queues = yield* runScheduledWork(durableQueueHealthSchedule)(observeDurableQueueHealth);
  yield* Ref.set(durableQueueReadinessSnapshot, projectDurableQueueReadiness(queues));
}).pipe(Effect.ignoreCause);

/** Best-effort durable-queue health scheduling; authoritative retry budgets stay in the store. */
export const DurableQueueHealthMaintenanceLive = Layer.effectDiscard(
  runBestEffortMaintenance({
    timing: "best-effort",
    cadence: "1 minute",
    work: probeDurableQueueHealth,
  }).pipe(Effect.forkScoped)
);

const privateReadinessResponse = Effect.fn(function* (assertion: string) {
  const verifier = yield* SupportAccessVerifier;
  yield* verifier.verify(Redacted.make(assertion));
  return yield* Ref.get(durableQueueReadinessSnapshot).pipe(
    Effect.flatMap((readiness) =>
      HttpServerResponse.json(readiness, { headers: { "cache-control": "no-store" } })
    )
  );
});

const privateReadinessUnavailable = (
  status: typeof unauthorizedStatus | typeof serviceUnavailableStatus
): HttpServerResponse.HttpServerResponse =>
  HttpServerResponse.empty({ status, headers: { "cache-control": "no-store" } });

const DurableQueueReadinessRouteLive = HttpRouter.add(
  "GET",
  "/internal/readiness/durable-queues",
  (request) => {
    const assertion = request.headers["cf-access-jwt-assertion"];
    if (assertion === undefined || assertion.length === 0) {
      return Effect.succeed(privateReadinessUnavailable(unauthorizedStatus));
    }
    return privateReadinessResponse(assertion).pipe(
      Effect.catchTags({
        SupportAccessUnauthorized: () =>
          Effect.succeed(privateReadinessUnavailable(unauthorizedStatus)),
        SupportAccessUnavailable: () =>
          Effect.succeed(privateReadinessUnavailable(serviceUnavailableStatus)),
      })
    );
  }
);

/** Access-protected cached readiness report for every production queue. */
export const DurableQueueReadinessLive = Layer.merge(
  DurableQueueReadinessRouteLive,
  Layer.effectDiscard(
    getDurableQueueHealth.pipe(
      Effect.map(projectDurableQueueReadiness),
      Effect.flatMap((readiness) => Ref.set(durableQueueReadinessSnapshot, readiness))
    )
  )
);
