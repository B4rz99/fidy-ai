import { Array, Config, ConfigProvider, Duration, Effect, Layer, Option, Schema } from "effect";
import { ClusterWorkflowEngine, RunnerAddress, TestRunner } from "effect/unstable/cluster";
import { PersistedQueue } from "effect/unstable/persistence";
import { WorkflowEngine } from "effect/unstable/workflow";
import { configuredSecret } from "~/shell/_shared/configured-secret";
import {
  maximumHostedTurnIterations,
  maximumModelRoundMillis,
} from "~/shell/_shared/hosted-turn-bounds";
import { authenticatedClusterHttp } from "./authenticated-cluster-http";
import type { ClusterRunnerHttpPolicy } from "./cluster-runner-http";

const ClusterAuthenticationToken = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const durableQueueTable = "fidy_queue";
const clusterAuthenticationToken = configuredSecret({
  name: "FIDY_CLUSTER_AUTH_TOKEN",
  schema: ClusterAuthenticationToken,
  requirement: "must be a 32-byte lowercase hexadecimal key",
});

// A hosted Turn admits at most `maximumHostedTurnIterations` model rounds, each bounded at
// `maximumModelRoundMillis`. The Work deadline is sized above that bounded budget plus delivery
// margin as the transport's safety net for a stalled runner: it bounds one caller's wait, not the
// Turn's execution. A Turn whose tool calls outlive it keeps running under its own limits and
// settles durably, so an expired wait detaches the caller instead of cancelling the Work. Health
// probes use the upstream ping bound instead of waiting on a dead runner.
const workDeadlineMarginMinutes = 10;
const productionRunnerHealthDeadlineSeconds = 10;
const workDeadlineMargin = Duration.minutes(workDeadlineMarginMinutes);

/** Fast health probe, so shard ownership can move away from a dead runner. */
export const productionRunnerHealthDeadline = Duration.seconds(
  productionRunnerHealthDeadlineSeconds
);

/** Work wait sized above the hosted Turn's bounded model-round budget plus delivery margin. */
export const productionRunnerRequestDeadline = Duration.sum(
  Duration.millis(maximumHostedTurnIterations * maximumModelRoundMillis),
  workDeadlineMargin
);

const blankRunnerAdvertisedHostError = (): Config.ConfigError =>
  new Config.ConfigError(
    new ConfigProvider.SourceError({ message: "FIDY_CLUSTER_RUNNER_HOST must not be blank" })
  );

/**
 * This replica's advertised runner host; a client-only process may not have one. A blank value is
 * rejected rather than admitted into an allowlist that could match no runner address.
 */
const runnerAdvertisedHost = Config.string("FIDY_CLUSTER_RUNNER_HOST").pipe(
  Config.mapOrFail((host): Effect.Effect<string, Config.ConfigError> => {
    const advertised = host.trim();
    return advertised !== ""
      ? Effect.succeed(advertised)
      : Effect.fail(blankRunnerAdvertisedHostError());
  })
);

/** The runner port every replica listens on. */
const runnerPort = Config.port("FIDY_CLUSTER_RUNNER_PORT");

/** This replica's advertised runner address, as registered in shared runner storage. */
const runnerHostAndPort = Config.all({
  host: runnerAdvertisedHost,
  port: runnerPort,
});

/**
 * Additional private runner hosts that may receive the shared credential, beyond this replica's
 * advertised one. Every replica listens on the configured runner port, so peers differ by host.
 */
const runnerPeerHosts = Config.string("FIDY_CLUSTER_RUNNER_PEER_HOSTS").pipe(
  Config.withDefault(""),
  Config.map((hosts) =>
    hosts
      .split(",")
      .map((host) => host.trim())
      .filter((host) => host !== "")
  )
);

const missingRunnerHostError = (): Config.ConfigError =>
  new Config.ConfigError(
    new ConfigProvider.SourceError({
      message:
        "FIDY_CLUSTER_RUNNER_HOST or FIDY_CLUSTER_RUNNER_PEER_HOSTS must configure at least one runner host",
    })
  );

/** Rebuilds a configured host list as non-empty, or reports the configuration gap. */
const requireRunnerHosts = (
  hosts: ReadonlyArray<string>
): Effect.Effect<Array.NonEmptyArray<string>, Config.ConfigError> =>
  Option.match(Array.head(hosts), {
    onNone: () => Effect.fail(missingRunnerHostError()),
    onSome: (head) => Effect.succeed(Array.prepend(hosts.slice(1), head)),
  });

/**
 * Private runner hosts a client-only process may dial: its advertised host when configured, plus
 * every configured peer. At least one host is required, so a client cannot start with an empty
 * allowlist that would refuse every runner.
 */
const clientRunnerHosts = Config.all({
  advertised: Config.option(runnerAdvertisedHost),
  peers: runnerPeerHosts,
}).pipe(
  Config.mapOrFail(
    ({ advertised, peers }): Effect.Effect<Array.NonEmptyArray<string>, Config.ConfigError> => {
      const hosts = Option.match(advertised, {
        onNone: () => peers,
        onSome: (host) => Array.prepend(peers, host),
      });
      return requireRunnerHosts(hosts);
    }
  )
);

/**
 * Private Cluster policy for the configured runner hosts. Runner addresses come from shared runner
 * storage, so an address is only dialed when it is one of the configured hosts, on the shared
 * runner port.
 */
const productionClusterRunnerHttpPolicy = (
  runnerHosts: Array.NonEmptyArray<string>,
  port: number
): ClusterRunnerHttpPolicy => ({
  runnerHosts,
  runnerPorts: { _tag: "Configured", ports: [port] },
  healthDeadline: productionRunnerHealthDeadline,
  requestDeadline: productionRunnerRequestDeadline,
});

const ProductionClusterLive = Layer.unwrap(
  Effect.gen(function* () {
    const { host: advertisedHost, port } = yield* runnerHostAndPort;
    const peerHosts = yield* runnerPeerHosts;
    const listenHost = yield* Config.string("FIDY_CLUSTER_LISTEN_HOST").pipe(
      Config.withDefault("0.0.0.0")
    );
    const authenticationToken = yield* clusterAuthenticationToken;
    return authenticatedClusterHttp.layerSql(
      authenticationToken,
      {
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
      },
      productionClusterRunnerHttpPolicy(Array.prepend(peerHosts, advertisedHost), port)
    );
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
    const runnerHosts = yield* clientRunnerHosts;
    const port = yield* runnerPort;
    return Layer.mergeAll(
      SqlPersistedQueueLive,
      ClusterWorkflowEngine.layer.pipe(
        Layer.provideMerge(
          authenticatedClusterHttp.layerSql(
            token,
            {
              runnerAddress: Option.none(),
              availableShardGroups: ["default"],
              assignedShardGroups: [],
              shardsPerGroup: 300,
              shardLockDisableAdvisory: true,
            },
            productionClusterRunnerHttpPolicy(runnerHosts, port)
          )
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
