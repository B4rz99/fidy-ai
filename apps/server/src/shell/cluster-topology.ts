import { Duration, Equal, Function, Option, Schema } from "effect";
import { RunnerAddress, type ShardingConfig } from "effect/unstable/cluster";

/**
 * Durable table namespace shared by Cluster message and runner storage. Changing it points a runner
 * at a different mailbox and lock set, so it is part of the compatibility identity.
 */
export const clusterStoragePrefix = "cluster";

/** The only approved Cluster frame serialization. Every runner and client must agree on it. */
export const clusterSerialization = "msgpack";

/** Bound applied to one encoded Cluster frame before protocol decoding. */
export const clusterSerializationMaxBufferSizeBytes = 65_536;

/**
 * Deployment generation for the Cluster entity, RPC, and workflow schema. Bump it only with a
 * coordinated drain of every runner: additive-compatible releases keep the same generation, and
 * readers that cannot decode the new schema are refused instead of corrupting persisted Work.
 */
export const clusterProtocolGeneration = 1;

/**
 * Bounded identity covering routing, storage, and lock agreement. It deliberately excludes runner
 * addresses, shard group assignment, weights, and local timing overrides: those may differ per
 * process without splitting shard ownership or the durable mailbox. Lock mode and lock expiration
 * are included because they select the lock mechanism and the staleness window every runner uses to
 * decide whether another runner's shards are free. Fields are decoded leniently from the published
 * row so a divergent value becomes a named difference instead of an opaque parse error.
 */
export const ClusterCompatibilityIdentity = Schema.Struct({
  protocolGeneration: Schema.Int,
  shardsPerGroup: Schema.Int,
  availableShardGroups: Schema.Array(Schema.String),
  serialization: Schema.String,
  serializationMaxBufferSize: Schema.Int,
  messageStoragePrefix: Schema.String,
  runnerStoragePrefix: Schema.String,
  shardLockDisableAdvisory: Schema.Boolean,
  shardLockExpirationMillis: Schema.Int,
});
export type ClusterCompatibilityIdentity = typeof ClusterCompatibilityIdentity.Type;

export type ClusterCompatibilityField = keyof ClusterCompatibilityIdentity;

const isClusterCompatibilityField = (field: string): field is ClusterCompatibilityField =>
  Object.hasOwn(ClusterCompatibilityIdentity.fields, field);

/**
 * Contract fields that must match across every process that routes to or owns shards. Derived from
 * the identity schema so a field cannot join the identity without joining this list.
 */
export const clusterCompatibilityFields: ReadonlyArray<ClusterCompatibilityField> = Object.keys(
  ClusterCompatibilityIdentity.fields
).filter(isClusterCompatibilityField);

/** Derives the shared compatibility identity from one runner's effective Sharding configuration. */
export const clusterCompatibilityIdentity = (
  sharding: ShardingConfig.ShardingConfig["Service"]
): ClusterCompatibilityIdentity => ({
  protocolGeneration: clusterProtocolGeneration,
  shardsPerGroup: sharding.shardsPerGroup,
  availableShardGroups: Array.from(new Set(sharding.availableShardGroups)).sort(),
  serialization: clusterSerialization,
  serializationMaxBufferSize: clusterSerializationMaxBufferSizeBytes,
  messageStoragePrefix: clusterStoragePrefix,
  runnerStoragePrefix: clusterStoragePrefix,
  shardLockDisableAdvisory: sharding.shardLockDisableAdvisory,
  shardLockExpirationMillis: Duration.toMillis(sharding.shardLockExpiration),
});

/** Names every compatibility field whose published value differs from the local deployment. */
export const clusterCompatibilityDifferences: {
  (
    published: ClusterCompatibilityIdentity
  ): (local: ClusterCompatibilityIdentity) => ReadonlyArray<ClusterCompatibilityField>;
  (
    published: ClusterCompatibilityIdentity,
    local: ClusterCompatibilityIdentity
  ): ReadonlyArray<ClusterCompatibilityField>;
} = Function.dual(
  2,
  (published: ClusterCompatibilityIdentity, local: ClusterCompatibilityIdentity) =>
    clusterCompatibilityFields.filter((field) => !Equal.equals(published[field], local[field]))
);

/** The explicit production Cluster deployment contract for one runner process. */
export type ClusterTopology = Readonly<{
  readonly sharding: ShardingConfig.ShardingConfig["Service"];
  readonly compatibility: ClusterCompatibilityIdentity;
}>;

/**
 * Deliberate settings shared by runner and client processes. Defaults are adopted consciously:
 * 300 shards per group keeps lock traffic per refresh small while spreading resident entities;
 * row locks with a 10 second refresh and 35 second expiry survive one dropped pool connection; a
 * 15 second entity termination timeout precedes lock expiry; and the remaining mailbox, polling,
 * health, and retry timings are tuned for hosted Turn recovery within tens of seconds.
 */
const shardLockRefreshIntervalSeconds = 10;
const shardLockExpirationSeconds = 35;
const entityTerminationTimeoutSeconds = 15;
const entityMessagePollIntervalSeconds = 10;
const entityReplyPollIntervalMillis = 200;

const sharedClusterSharding: Omit<
  ShardingConfig.ShardingConfig["Service"],
  "runnerAddress" | "runnerListenAddress" | "assignedShardGroups"
> = {
  runnerShardWeight: 1,
  shardsPerGroup: 300,
  availableShardGroups: ["default"],
  preemptiveShutdown: true,
  shardLockRefreshInterval: Duration.seconds(shardLockRefreshIntervalSeconds),
  shardLockExpiration: Duration.seconds(shardLockExpirationSeconds),
  shardLockDisableAdvisory: true,
  entityMailboxCapacity: 4096,
  maxResidentEntities: 10_000,
  unprocessedMessageBatchSize: 1024,
  entityMaxIdleTime: Duration.minutes(1),
  entityRegistrationTimeout: Duration.minutes(1),
  entityTerminationTimeout: Duration.seconds(entityTerminationTimeoutSeconds),
  entityMessagePollInterval: Duration.seconds(entityMessagePollIntervalSeconds),
  entityReplyPollInterval: Duration.millis(entityReplyPollIntervalMillis),
  sendRetryInterval: Duration.millis(100),
  refreshAssignmentsInterval: Duration.seconds(3),
  runnerHealthCheckInterval: Duration.minutes(1),
  simulateRemoteSerialization: true,
};

/** Builds the complete runner topology from the deployment's advertised and listen addresses. */
export const productionRunnerTopology = (options: {
  readonly advertisedHost: string;
  readonly listenHost: string;
  readonly port: number;
}): ClusterTopology => {
  const sharding: ShardingConfig.ShardingConfig["Service"] = {
    ...sharedClusterSharding,
    runnerAddress: Option.some(RunnerAddress.make(options.advertisedHost, options.port)),
    runnerListenAddress: Option.some(RunnerAddress.make(options.listenHost, options.port)),
    assignedShardGroups: ["default"],
  };
  return { sharding, compatibility: clusterCompatibilityIdentity(sharding) };
};

/** Builds the client-only topology: no shard ownership, identical routing and storage agreement. */
export const clientClusterTopology = (): ClusterTopology => {
  const sharding: ShardingConfig.ShardingConfig["Service"] = {
    ...sharedClusterSharding,
    runnerAddress: Option.none(),
    runnerListenAddress: Option.none(),
    assignedShardGroups: [],
  };
  return { sharding, compatibility: clusterCompatibilityIdentity(sharding) };
};
