/**
 * Shared SQL Cluster test topology. The deployment-wide compatibility identity pins one shard count
 * for every process on a database, so every integration scenario and subprocess fixture must use
 * these values even when it would rather exercise fewer shards.
 */
import { Effect, Layer, Option, Redacted, Schema } from "effect";
import { RunnerAddress, ShardId, type ShardingConfig } from "effect/unstable/cluster";
import { SqlSchema } from "effect/unstable/sql";
import { Workflow, type WorkflowEngine } from "effect/unstable/workflow";
import { MigrationSqlClient, MigrationSqlClientLive } from "./database-harness";
import {
  clusterLocksTable,
  clusterRunnersTable,
  topologyIdentityTable,
} from "~/shell/durable-tables";

const clusterTestTokenHexLength = 64;

/** 32-byte bearer token encoded as 64 hex characters for every test runner and client. */
export const clusterTestAuthenticationToken = Redacted.make("f".repeat(clusterTestTokenHexLength));

/** Shard count the shared test topology publishes in the deployment compatibility identity. */
export const clusterTestShardCount = 300;

/** Lease settings leave enough time for a 300-shard SQL batch on a cold test process. */
export const clusterTestShardLockRefreshInterval = 1_000;
export const clusterTestShardLockExpiration = "5 seconds";

/** Every shard id in the shared test topology, used to count live ownership. */
export const clusterTestShardIds = Array.from({ length: clusterTestShardCount }, (_, index) =>
  ShardId.make("default", index + 1)
);

/** Releases test runtimes concurrently so a timed-out scenario cannot retain shard ownership. */
export const disposeTestRuntimes = (
  runtimes: ReadonlyArray<{ readonly dispose: () => Promise<void> }>
): Effect.Effect<void> =>
  Effect.tryPromise(() => Promise.all(runtimes.map((runtime) => runtime.dispose()))).pipe(
    Effect.orDie,
    Effect.asVoid
  );

/**
 * Topology every SQL Cluster scenario shares. Row leases match production so the identity and the
 * recovery paths stay production-shaped, but the lease window is deliberately short: a disposed
 * runtime's shard locks and runner registration must stop attracting Work within a test's timeout
 * instead of lingering for production's 35-second staleness budget. Scenarios may tighten further.
 */
export const clusterTestSharedOptions = {
  availableShardGroups: ["default"],
  assignedShardGroups: ["default"],
  shardsPerGroup: clusterTestShardCount,
  entityMessagePollInterval: 50,
  sendRetryInterval: 50,
  shardLockDisableAdvisory: true,
  shardLockRefreshInterval: clusterTestShardLockRefreshInterval,
  shardLockExpiration: clusterTestShardLockExpiration,
} satisfies Partial<ShardingConfig.ShardingConfig["Service"]>;

/** Builds the shared test topology for one loopback runner, with scenario-specific overrides. */
export const clusterTestRunnerOptions = ({
  port,
  overrides,
}: {
  readonly port: number;
  readonly overrides: Partial<ShardingConfig.ShardingConfig["Service"]>;
}): Partial<ShardingConfig.ShardingConfig["Service"]> => ({
  ...clusterTestSharedOptions,
  runnerAddress: Option.some(RunnerAddress.make("127.0.0.1", port)),
  runnerListenAddress: Option.some(RunnerAddress.make("127.0.0.1", port)),
  ...overrides,
});

const clusterTopologyProbeWorkflowName = "ClusterTopologyProbe";

/**
 * Test Workflow the hard-loss scenario persists on the shard a doomed runner owns but cannot serve.
 * Completion after the SIGKILL is the durable-mailbox recovery signal.
 */
export const clusterTopologyProbeWorkflow = Workflow.make(clusterTopologyProbeWorkflowName, {
  payload: { probe: Schema.String },
  idempotencyKey: ({ probe }) => probe,
  success: Schema.String,
});

/** Entity type the durable mailbox stores for the probe workflow; used to assert persisted Work. */
export const clusterTopologyProbeEntityType = `Workflow/${clusterTopologyProbeWorkflowName}`;

/** A runner that registers this entity can execute and complete the persisted probe. */
export const clusterTopologyProbeWorkflowLayer: Layer.Layer<
  never,
  never,
  WorkflowEngine.WorkflowEngine
> = clusterTopologyProbeWorkflow.toLayer(() => Effect.succeed("recovered"));

const clearClusterTableIfPresent = Effect.fn(function* (tableName: string) {
  const sql = yield* MigrationSqlClient;
  const { exists } = yield* SqlSchema.findOne({
    Request: Schema.Void,
    Result: Schema.Struct({ exists: Schema.Boolean }),
    execute: () => sql`SELECT to_regclass(${`fidy_durable.${tableName}`}) IS NOT NULL AS exists`,
  })(undefined).pipe(Effect.orDie);
  if (exists) yield* sql`DELETE FROM fidy_durable.${sql(tableName)}`;
});

/**
 * Deletes the published identity before the first SQL Cluster runtime creates its storage tables.
 * The helper owns its privileged migration connection because the runtime role cannot delete it.
 */
export const resetClusterTopologyIdentity: Effect.Effect<void> = Layer.build(
  Layer.effectDiscard(clearClusterTableIfPresent(topologyIdentityTable)).pipe(
    Layer.provide(MigrationSqlClientLive)
  )
).pipe(Effect.scoped, Effect.orDie);

/** Clears inactive runner ownership and identity between serialized deployment scenarios. */
export const resetClusterTopologyState: Effect.Effect<void> = Layer.build(
  Layer.effectDiscard(
    Effect.gen(function* () {
      yield* clearClusterTableIfPresent(clusterLocksTable);
      yield* clearClusterTableIfPresent(clusterRunnersTable);
      yield* clearClusterTableIfPresent(topologyIdentityTable);
    })
  ).pipe(Layer.provide(MigrationSqlClientLive))
).pipe(Effect.scoped, Effect.orDie);
