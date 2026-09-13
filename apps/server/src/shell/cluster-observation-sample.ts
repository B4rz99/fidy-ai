import { Clock, Duration, Effect, Option, Predicate, Schema } from "effect";
import {
  type ClusterError,
  RunnerStorage,
  Sharding,
  ShardingConfig,
  Snowflake,
} from "effect/unstable/cluster";
import { SqlClient } from "effect/unstable/sql";
import { ClusterTelemetry } from "./cluster-telemetry";
import { clusterLocksTable, clusterMessagesTable, durableQueueTable } from "./durable-tables";

/** One bounded reading of runner health, shard ownership, mailbox pressure, and retries. */
export type ClusterObservationSample = Readonly<{
  isShutdown: boolean;
  runnersTotal: number;
  runnersHealthy: number;
  /** Fresh deployment-wide shard locks currently held by the runner fleet. */
  assignedShards: number;
  /** Shards every configured group must have assigned; the difference is assignment lag. */
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
const ShardAssignmentSample = Schema.Struct({ assigned: Schema.Int });

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

const readShardAssignmentSample: (
  sql: SqlClient.SqlClient,
  freshAfterMillis: number
) => Effect.Effect<ReadonlyArray<typeof ShardAssignmentSample.Type>, never> = (
  sql,
  freshAfterMillis
) =>
  sql`
    SELECT count(*)::int AS "assigned"
    FROM fidy_durable.${sql(clusterLocksTable)}
    WHERE acquired_at >= to_timestamp(${freshAfterMillis}::double precision / 1000)
  `.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ShardAssignmentSample))),
    Effect.orDie
  );

const emptyMailboxSample: typeof MailboxSample.Type = {
  unprocessed: 0,
  redeliveries: 0,
  oldest: Option.none(),
};
const emptyQueueSample: typeof QueueSample.Type = { retries: 0, pendingRetries: 0 };
const emptyShardAssignmentSample: typeof ShardAssignmentSample.Type = { assigned: 0 };

type FirstOr = <A>(rows: ReadonlyArray<A>, fallback: A) => A;
const firstOr: FirstOr = (rows, fallback) => rows[0] ?? fallback;

/** Cluster services required to take one topology observation sample. */
export type ClusterObservationDependencies =
  | Sharding.Sharding
  | RunnerStorage.RunnerStorage
  | ShardingConfig.ShardingConfig
  | ClusterTelemetry;

/**
 * Reads only bounded aggregate infrastructure state. Shard assignment lag comes from fresh durable
 * lock rows rather than a second implementation of Effect's hash-ring algorithm; no address,
 * entity id, User id, payload, or operation tag leaves this boundary.
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
  const [mailbox, queue, shardAssignment] = yield* Effect.all([
    readMailboxSample(sql, now),
    readQueueSample(sql),
    readShardAssignmentSample(sql, now - Duration.toMillis(config.shardLockExpiration)),
  ]);
  const snapshot = yield* telemetry.snapshot;
  const residentEntities = yield* sharding.activeEntityCount;

  const mailboxRow = firstOr(mailbox, emptyMailboxSample);
  const queueRow = firstOr(queue, emptyQueueSample);
  const shardAssignmentRow = firstOr(shardAssignment, emptyShardAssignmentSample);
  return {
    isShutdown: yield* sharding.isShutdown,
    runnersTotal: runners.length,
    runnersHealthy: runners.filter(([, healthy]) => healthy).length,
    assignedShards: shardAssignmentRow.assigned,
    expectedShards: config.shardsPerGroup * config.availableShardGroups.length,
    shardLockFailures: snapshot.lockFailures,
    shardLockRefreshAgeMillis: Option.map(snapshot.lastLockRefreshAtMillis, (lastRefresh) =>
      Math.max(0, now - lastRefresh)
    ),
    mailboxUnprocessed: mailboxRow.unprocessed,
    mailboxOldestAgeMillis: Option.map(mailboxRow.oldest, (oldest) =>
      Math.max(0, now - Snowflake.timestamp(Snowflake.Snowflake(oldest)))
    ),
    mailboxRedeliveries: mailboxRow.redeliveries,
    residentEntities,
    residentEntityCapacity: Option.liftPredicate(config.maxResidentEntities, Predicate.isNumber),
    queueRetriesTotal: queueRow.retries,
    queuePendingRetries: queueRow.pendingRetries,
    requestRetriesTotal: snapshot.requestRetries,
  };
});
