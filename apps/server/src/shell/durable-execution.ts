import { Config, Effect, Layer, Option, Schema } from "effect";
import { ClusterWorkflowEngine, RunnerAddress, TestRunner } from "effect/unstable/cluster";
import { PersistedQueue } from "effect/unstable/persistence";
import { WorkflowEngine } from "effect/unstable/workflow";
import { configuredSecret } from "./_shared/configured-secret";
import { authenticatedClusterHttp } from "./authenticated-cluster-http";

const ClusterAuthenticationToken = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const durableQueueTable = "fidy_queue";
const clusterAuthenticationToken = configuredSecret({
  name: "FIDY_CLUSTER_AUTH_TOKEN",
  schema: ClusterAuthenticationToken,
  requirement: "must be a 32-byte lowercase hexadecimal key",
});

const ProductionClusterLive = Layer.unwrap(
  Effect.gen(function* () {
    const { advertisedHost, listenHost, port } = yield* Config.all({
      advertisedHost: Config.string("FIDY_CLUSTER_RUNNER_HOST"),
      port: Config.port("FIDY_CLUSTER_RUNNER_PORT"),
      listenHost: Config.string("FIDY_CLUSTER_LISTEN_HOST").pipe(Config.withDefault("0.0.0.0")),
    });
    const authenticationToken = yield* clusterAuthenticationToken;
    return authenticatedClusterHttp.layerSql(authenticationToken, {
      runnerAddress: Option.some(RunnerAddress.make(advertisedHost, port)),
      runnerListenAddress: Option.some(RunnerAddress.make(listenHost, port)),
      availableShardGroups: ["default"],
      assignedShardGroups: ["default"],
      shardsPerGroup: 300,
      // Row leases survive a dropped pool connection; refresh plus entity shutdown precede expiry.
      shardLockDisableAdvisory: true,
      shardLockRefreshInterval: "10 seconds",
      entityTerminationTimeout: "15 seconds",
      shardLockExpiration: "35 seconds",
    });
  })
);

const SqlPersistedQueueLive = PersistedQueue.layer.pipe(
  Layer.provideMerge(PersistedQueue.layerStoreSql({ tableName: durableQueueTable }))
);

/**
 * SQL-backed production substrate for native queues and workflows. The runner listener must
 * remain private; every runner request additionally requires the shared Cluster bearer token.
 */
const ProductionWorkflowLive = ClusterWorkflowEngine.layer.pipe(
  Layer.provideMerge(ProductionClusterLive)
);

export const DurableExecutionLive = Layer.mergeAll(SqlPersistedQueueLive, ProductionWorkflowLive);

/** CLI routes through production owners without acquiring shards or creating another local mailbox. */
export const DurableExecutionClientLive = Layer.unwrap(
  Effect.gen(function* () {
    const token = yield* clusterAuthenticationToken;
    return Layer.mergeAll(
      SqlPersistedQueueLive,
      ClusterWorkflowEngine.layer.pipe(
        Layer.provideMerge(
          authenticatedClusterHttp.layerSql(token, {
            runnerAddress: Option.none(),
            availableShardGroups: ["default"],
            assignedShardGroups: [],
            shardsPerGroup: 300,
            shardLockDisableAdvisory: true,
          })
        )
      )
    );
  })
);

/** Volatile native substrate for tests that do not assert process-loss or cross-runtime behavior. */
export const DurableExecutionMemory = Layer.mergeAll(
  PersistedQueue.layer.pipe(Layer.provideMerge(PersistedQueue.layerStoreMemory)),
  WorkflowEngine.layerMemory,
  TestRunner.layer
);

/** SQL queue plus volatile workflow history for PostgreSQL integration seams without a runner port. */
export const DurableExecutionSqlQueueMemoryWorkflow = Layer.mergeAll(
  SqlPersistedQueueLive,
  WorkflowEngine.layerMemory,
  TestRunner.layer
);
