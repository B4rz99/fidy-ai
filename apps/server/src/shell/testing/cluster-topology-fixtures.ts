/**
 * Shared SQL Cluster test topology. The deployment-wide compatibility identity pins one shard count
 * for every process on a database, so every integration scenario and subprocess fixture must use
 * these values even when it would rather exercise fewer shards.
 */
import { Effect, Layer, Redacted, Schema } from "effect";
import { ShardId, type ShardingConfig } from "effect/unstable/cluster";
import { Workflow, type WorkflowEngine } from "effect/unstable/workflow";
import { MigrationSqlClient } from "~/shell/db/client";

const clusterTestAuthenticationTokenBytes = 64;

/** 64-byte bearer token every test runner and client presents to the Cluster HTTP listener. */
export const clusterTestAuthenticationToken = Redacted.make(
  "f".repeat(clusterTestAuthenticationTokenBytes)
);

/** Shard count the shared test topology publishes in the deployment compatibility identity. */
export const clusterTestShardCount = 300;

/** Every shard id in the shared test topology, used to count live ownership. */
export const clusterTestShardIds = Array.from({ length: clusterTestShardCount }, (_, index) =>
  ShardId.make("default", index + 1)
);

/** Topology every SQL Cluster scenario shares; scenarios may tighten lease timings on top. */
export const clusterTestSharedOptions = {
  availableShardGroups: ["default"],
  assignedShardGroups: ["default"],
  shardsPerGroup: clusterTestShardCount,
  entityMessagePollInterval: 50,
  sendRetryInterval: 50,
  shardLockDisableAdvisory: true,
} satisfies Partial<ShardingConfig.ShardingConfig["Service"]>;

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

/**
 * Deletes the published compatibility identity so the next runners behave as a fresh deployment.
 * Integration files share one database but simulate independent deployments with their own lock
 * timings, and the identity is published first-writer-wins, so a file whose topology differs from
 * the previous file's must reset it before its first runner starts. The helper owns its privileged
 * migration connection because the runtime role may only read and insert the identity.
 */
export const resetClusterTopologyIdentity: Effect.Effect<void> = Layer.build(
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* MigrationSqlClient;
      yield* sql`DELETE FROM fidy_durable.cluster_topology_identity`;
    })
  ).pipe(Layer.provide(MigrationSqlClient.layer))
).pipe(Effect.scoped, Effect.orDie);
