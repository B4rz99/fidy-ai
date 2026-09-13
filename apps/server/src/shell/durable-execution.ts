import { Config, Effect, Layer, Schema } from "effect";
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster";
import { PersistedQueue } from "effect/unstable/persistence";
import { WorkflowEngine } from "effect/unstable/workflow";
import { configuredSecret } from "~/shell/_shared/configured-secret";
import {
  durableQueueLockExpiration,
  durableQueueLockRefreshInterval,
  durableQueuePollInterval,
  durableQueueTableName,
} from "./durable-queue-policy";
import { authenticatedClusterHttp } from "./authenticated-cluster-http";
import { ClusterObservationLive } from "./cluster-observation";
import { ClusterReadinessVolatile } from "./cluster-readiness";
import { clientClusterTopology, productionRunnerTopology } from "./cluster-topology";

const ClusterAuthenticationToken = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
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
    return authenticatedClusterHttp.layerSql(
      authenticationToken,
      productionRunnerTopology({ advertisedHost, listenHost, port }).sharding
    );
  })
);

/** Shared SQL queue substrate using the explicit production table and lock policy. */
export const SqlPersistedQueueLive = PersistedQueue.layer.pipe(
  Layer.provideMerge(
    PersistedQueue.layerStoreSql({
      tableName: durableQueueTableName,
      pollInterval: durableQueuePollInterval,
      lockRefreshInterval: durableQueueLockRefreshInterval,
      lockExpiration: durableQueueLockExpiration,
    })
  )
);

/**
 * SQL-backed production substrate for native queues, workflows, and runner observation. The runner
 * listener must remain private; every runner request additionally requires the shared Cluster bearer
 * token and the deployment must have published a matching topology compatibility identity.
 */
const ProductionWorkflowLive = ClusterWorkflowEngine.layer.pipe(
  Layer.provideMerge(ProductionClusterLive)
);

export const DurableExecutionLive = ClusterObservationLive.pipe(
  Layer.provideMerge(Layer.mergeAll(SqlPersistedQueueLive, ProductionWorkflowLive))
);

/** CLI routes through production owners without acquiring shards or creating another local mailbox. */
export const DurableExecutionClientLive = Layer.unwrap(
  Effect.gen(function* () {
    const token = yield* clusterAuthenticationToken;
    return Layer.mergeAll(
      SqlPersistedQueueLive,
      ClusterWorkflowEngine.layer.pipe(
        Layer.provideMerge(
          authenticatedClusterHttp.layerSqlClient(token, clientClusterTopology().sharding)
        )
      )
    );
  })
);

/** Volatile native substrate for tests that do not assert process-loss or cross-runtime behavior. */
export const DurableExecutionMemory = Layer.mergeAll(
  PersistedQueue.layer.pipe(Layer.provideMerge(PersistedQueue.layerStoreMemory)),
  WorkflowEngine.layerMemory,
  TestRunner.layer,
  ClusterReadinessVolatile
);
