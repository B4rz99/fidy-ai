import { Cause, Clock, Effect, Function, Layer, Option, Ref, Schema } from "effect";
import {
  type ClusterError,
  RunnerStorage,
  Sharding,
  ShardingConfig,
  Snowflake,
} from "effect/unstable/cluster";
import { SqlClient } from "effect/unstable/sql";
import { shardCoverage } from "./cluster-shard-coverage";
import { ClusterTelemetry } from "./cluster-telemetry";
import { clusterMessagesTable, durableQueueTable } from "./durable-tables";
import { runBestEffortMaintenance } from "./maintenance-schedule";
import {
  type TelemetryCount,
  type TelemetryDuration,
  boundedTelemetryCount,
  boundedTelemetryDuration,
} from "~/shell/observability/protocol";

const clusterObservationInterval = "60 seconds";

/** One bounded reading of runner health, shard ownership, mailbox pressure, and retries. */
export type ClusterObservationSample = Readonly<{
  isShutdown: boolean;
  runnersTotal: number;
  runnersHealthy: number;
  assignedShards: number;
  /** Shards the weighted hash ring assigns to this runner; the difference is assignment lag. */
  expectedShards: number;
  shardLockFailures: number;
  shardLockRefreshAgeMillis: Option.Option<number>;
  mailboxUnprocessed: number;
  mailboxOldestAgeMillis: Option.Option<number>;
  mailboxRedeliveries: number;
  residentEntities: number;
  /** Absent means `maxResidentEntities` is unbounded, so no capacity pressure exists. */
  residentEntityCapacity: Option.Option<number>;
  /** Cumulative durable-queue retries (attempts after the first); samples derive a rate from deltas. */
  queueRetriesTotal: number;
  queuePendingRetries: number;
  /** Cumulative cross-runner request calls retried after a retryable routing failure. */
  requestRetriesTotal: number;
}>;

const MailboxSample = Schema.Struct({
  unprocessed: Schema.Int,
  redeliveries: Schema.Int,
  // The aggregate yields SQL NULL when no unprocessed message is readable; absence is an Option.
  oldest: Schema.OptionFromNullOr(Schema.String),
});
const QueueSample = Schema.Struct({
  retries: Schema.Finite,
  pendingRetries: Schema.Int,
});

const readMailboxSample: (
  sql: SqlClient.SqlClient,
  now: number
) => Effect.Effect<ReadonlyArray<typeof MailboxSample.Type>, never> = (sql, now) =>
  sql`
    SELECT
      count(*) FILTER (WHERE processed = false AND (deliver_at IS NULL OR deliver_at <= ${now}::bigint))::int AS "unprocessed",
      count(*) FILTER (WHERE processed = false AND last_read IS NOT NULL)::int AS "redeliveries",
      (min(id) FILTER (WHERE processed = false AND (deliver_at IS NULL OR deliver_at <= ${now}::bigint)))::text AS "oldest"
    FROM fidy_durable.${sql(clusterMessagesTable)}
  `.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(MailboxSample))),
    // The aggregate query has a fixed shape; a decode failure is a code defect, not a bad input.
    Effect.orDie
  );

const readQueueSample: (
  sql: SqlClient.SqlClient
) => Effect.Effect<ReadonlyArray<typeof QueueSample.Type>, never> = (sql) =>
  sql`
    SELECT
      COALESCE(SUM(GREATEST(attempts - 1, 0)), 0)::float8 AS "retries",
      count(*) FILTER (WHERE completed = false AND attempts > 0)::int AS "pendingRetries"
    FROM fidy_durable.${sql(durableQueueTable)}
  `.pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(QueueSample))), Effect.orDie);

/** Cluster services topology observation reads; `SqlClient` stays an explicit separate requirement. */
export type ClusterObservationDependencies =
  | Sharding.Sharding
  | RunnerStorage.RunnerStorage
  | ShardingConfig.ShardingConfig
  | ClusterTelemetry;

/**
 * Reads durable mailbox depth and age, redelivery pressure, Shard ownership, runner health, and
 * resident entity capacity. It reads aggregate counts and the oldest snowflake only: no entity id,
 * User id, payload, tag, or address is returned.
 */
export const sampleClusterObservation: Effect.Effect<
  ClusterObservationSample,
  ClusterError.PersistenceError,
  SqlClient.SqlClient | ClusterObservationDependencies
> = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sharding = yield* Sharding.Sharding;
  const runnerStorage = yield* RunnerStorage.RunnerStorage;
  const config = yield* ShardingConfig.ShardingConfig;
  const telemetry = yield* ClusterTelemetry;
  const now = yield* Clock.currentTimeMillis;

  const runners = yield* runnerStorage.getRunners;
  const mailbox = yield* readMailboxSample(sql, now);
  const queue = yield* readQueueSample(sql);
  const snapshot = yield* telemetry.snapshot;
  const residentEntities = yield* sharding.activeEntityCount;
  const coverage = shardCoverage(sharding, runners, config);

  const mailboxRow = mailbox[0] ?? {
    unprocessed: 0,
    redeliveries: 0,
    oldest: Option.none<string>(),
  };
  const oldestAge = Option.map(mailboxRow.oldest, (oldest) =>
    Math.max(0, now - Snowflake.timestamp(Snowflake.Snowflake(oldest)))
  );
  const maxResidentEntities = config.maxResidentEntities;
  return {
    isShutdown: yield* sharding.isShutdown,
    runnersTotal: runners.length,
    runnersHealthy: runners.filter(([, healthy]) => healthy).length,
    assignedShards: coverage.assigned,
    expectedShards: coverage.expected,
    shardLockFailures: snapshot.lockFailures,
    shardLockRefreshAgeMillis: Option.map(snapshot.lastLockRefreshAtMillis, (lastRefresh) =>
      Math.max(0, now - lastRefresh)
    ),
    mailboxUnprocessed: mailboxRow.unprocessed,
    mailboxOldestAgeMillis: oldestAge,
    mailboxRedeliveries: mailboxRow.redeliveries,
    residentEntities,
    residentEntityCapacity:
      typeof maxResidentEntities === "number" ? Option.some(maxResidentEntities) : Option.none(),
    queueRetriesTotal: queue[0]?.retries ?? 0,
    queuePendingRetries: queue[0]?.pendingRetries ?? 0,
    requestRetriesTotal: snapshot.requestRetries,
  };
});

/** Closed log projection: bounded branded counts, booleans, and Options for unobserved values. */
export type ClusterObservation = Readonly<{
  isShutdown: boolean;
  runnersTotal: TelemetryCount;
  runnersHealthy: TelemetryCount;
  assignedShards: TelemetryCount;
  expectedShards: TelemetryCount;
  /** Shards this process should hold but does not; the bounded shard assignment lag. */
  unassignedShards: TelemetryCount;
  shardLockFailures: TelemetryCount;
  shardLockRefreshAgeMillis: Option.Option<TelemetryDuration>;
  mailboxUnprocessed: TelemetryCount;
  mailboxOldestAgeMillis: Option.Option<TelemetryDuration>;
  mailboxRedeliveries: TelemetryCount;
  residentEntities: TelemetryCount;
  /** Absent when `maxResidentEntities` is unbounded; otherwise the limit and whether it is near. */
  residentCapacity: Option.Option<
    Readonly<{ readonly limit: TelemetryCount; readonly pressure: boolean }>
  >;
  queueRetriesTotal: TelemetryCount;
  queuePendingRetries: TelemetryCount;
  requestRetriesTotal: TelemetryCount;
  /** Retries gained since the previous readable sample; absent on the first sample. */
  retriesDelta: Option.Option<ClusterRetryDelta>;
}>;

/** Cumulative counts one sample compares against the previous reading to derive retry rates. */
export type ClusterRetryCounts = Readonly<{
  readonly queueRetries: number;
  readonly requestRetries: number;
}>;

/** Retries gained since the previous readable sample, split by retry source. */
export type ClusterRetryDelta = Readonly<{
  readonly queue: TelemetryCount;
  readonly request: TelemetryCount;
}>;

/** Capacity is reported as pressure once four fifths of the resident-entity limit is used. */
const entityCapacityPressureThreshold = 0.8;

/** Projects one sample into the bounded shape that may leave the process as telemetry. */
export const projectClusterObservation: {
  (
    previousRetries: Option.Option<ClusterRetryCounts>
  ): (sample: ClusterObservationSample) => ClusterObservation;
  (
    sample: ClusterObservationSample,
    previousRetries: Option.Option<ClusterRetryCounts>
  ): ClusterObservation;
} = Function.dual(
  2,
  (
    sample: ClusterObservationSample,
    previousRetries: Option.Option<ClusterRetryCounts>
  ): ClusterObservation => ({
    isShutdown: sample.isShutdown,
    runnersTotal: boundedTelemetryCount(sample.runnersTotal),
    runnersHealthy: boundedTelemetryCount(sample.runnersHealthy),
    assignedShards: boundedTelemetryCount(sample.assignedShards),
    expectedShards: boundedTelemetryCount(sample.expectedShards),
    unassignedShards: boundedTelemetryCount(
      Math.max(0, sample.expectedShards - sample.assignedShards)
    ),
    shardLockFailures: boundedTelemetryCount(sample.shardLockFailures),
    shardLockRefreshAgeMillis: Option.map(
      sample.shardLockRefreshAgeMillis,
      boundedTelemetryDuration
    ),
    mailboxUnprocessed: boundedTelemetryCount(sample.mailboxUnprocessed),
    mailboxOldestAgeMillis: Option.map(sample.mailboxOldestAgeMillis, boundedTelemetryDuration),
    mailboxRedeliveries: boundedTelemetryCount(sample.mailboxRedeliveries),
    residentEntities: boundedTelemetryCount(sample.residentEntities),
    residentCapacity: Option.map(sample.residentEntityCapacity, (limit) => ({
      limit: boundedTelemetryCount(limit),
      pressure: sample.residentEntities >= limit * entityCapacityPressureThreshold,
    })),
    queueRetriesTotal: boundedTelemetryCount(sample.queueRetriesTotal),
    queuePendingRetries: boundedTelemetryCount(sample.queuePendingRetries),
    requestRetriesTotal: boundedTelemetryCount(sample.requestRetriesTotal),
    retriesDelta: Option.map(previousRetries, (previous) => ({
      queue: boundedTelemetryCount(Math.max(0, sample.queueRetriesTotal - previous.queueRetries)),
      request: boundedTelemetryCount(
        Math.max(0, sample.requestRetriesTotal - previous.requestRetries)
      ),
    })),
  })
);

/** Structured-log projection: Option fields appear only when the sample produced a value. */
type ClusterObservationLogFields = Partial<{
  -readonly [Field in keyof ClusterObservation]: ClusterObservation[Field] extends Option.Option<
    infer Value
  >
    ? Value
    : ClusterObservation[Field];
}>;

/** Copies one present Option field into the log record; an absent field stays omitted. */
const setPresentLogField = <Field extends keyof ClusterObservationLogFields>(
  fields: ClusterObservationLogFields,
  field: Field,
  value: Option.Option<NonNullable<ClusterObservationLogFields[Field]>>
): void => {
  if (Option.isSome(value)) {
    fields[field] = value.value;
  }
};

/**
 * Flattens the observation for structured logging by omitting absent Option fields, so no Effect
 * wrapper and no placeholder leaks into the log record. A new Option field on `ClusterObservation`
 * must be handled here as well.
 */
const clusterObservationLogFields = (
  observation: ClusterObservation
): ClusterObservationLogFields => {
  const {
    shardLockRefreshAgeMillis,
    mailboxOldestAgeMillis,
    residentCapacity,
    retriesDelta,
    ...present
  } = observation;
  const fields: ClusterObservationLogFields = { ...present };
  setPresentLogField(fields, "shardLockRefreshAgeMillis", shardLockRefreshAgeMillis);
  setPresentLogField(fields, "mailboxOldestAgeMillis", mailboxOldestAgeMillis);
  setPresentLogField(fields, "residentCapacity", residentCapacity);
  setPresentLogField(fields, "retriesDelta", retriesDelta);
  return fields;
};

/**
 * Samples and emits one bounded structured observation. Durable-queue and cross-runner request
 * retries are compared against the previous sample to report rates; a real failure never interrupts
 * the schedule, and an unreadable first sample simply omits the rates. A scope-close interruption
 * only ends the loop and is never logged as an observation failure.
 */
export const observeClusterTopology = (
  previousRetries: Ref.Ref<Option.Option<ClusterRetryCounts>>
): Effect.Effect<void, never, SqlClient.SqlClient | ClusterObservationDependencies> =>
  Effect.gen(function* () {
    const sample = yield* sampleClusterObservation;
    const previous = yield* Ref.get(previousRetries);
    yield* Ref.set(
      previousRetries,
      Option.some({
        queueRetries: sample.queueRetriesTotal,
        requestRetries: sample.requestRetriesTotal,
      })
    );
    const observation = projectClusterObservation(sample, previous);
    yield* Effect.logInfo("Observed Cluster topology", clusterObservationLogFields(observation));
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("Cluster observation unavailable", { error: "observation_failed" })
    )
  );

/**
 * Runs the observation loop immediately and then at the operational cadence. A missed tick only
 * delays telemetry, so the loop is best-effort and dies with its owning layer scope.
 */
export const ClusterObservationLive: Layer.Layer<
  never,
  never,
  SqlClient.SqlClient | ClusterObservationDependencies
> = Layer.effectDiscard(
  Effect.gen(function* () {
    const previousRetries = yield* Ref.make(Option.none<ClusterRetryCounts>());
    yield* Effect.forkScoped(
      runBestEffortMaintenance({
        timing: "best-effort",
        cadence: clusterObservationInterval,
        work: observeClusterTopology(previousRetries),
      })
    );
  })
);
