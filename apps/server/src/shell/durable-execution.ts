import { Array, Config, ConfigProvider, Duration, Effect, Layer, Option } from "effect";
import { ClusterWorkflowEngine, TestRunner } from "effect/unstable/cluster";
import { WorkflowEngine } from "effect/unstable/workflow";
import { loadClusterAuthenticationToken } from "~/shell/secret-material/operations";
import { PersistedQueueSqlLive, VolatilePersistedQueue } from "~/shell/persisted-queue/runtime";
import {
  maximumHostedTurnIterations,
  maximumModelRoundMillis,
} from "~/shell/_shared/hosted-turn-bounds";
import type { ClusterRunnerHttpPolicy } from "./cluster-runner-http";
import { authenticatedClusterHttp } from "./authenticated-cluster-http";
import { ClusterObservationLive } from "./cluster-observation";
import { ClusterReadinessVolatile } from "./cluster-readiness";
import { clientClusterTopology, productionRunnerTopology } from "./cluster-topology";

const workDeadlineMarginMinutes = 10;
const runnerConnectDeadlineSeconds = 5;
const runnerHealthDeadlineSeconds = 10;
const workDeadlineMargin = Duration.minutes(workDeadlineMarginMinutes);
export const productionRunnerConnectDeadline = Duration.seconds(runnerConnectDeadlineSeconds);
export const productionRunnerHealthDeadline = Duration.seconds(runnerHealthDeadlineSeconds);
export const productionRunnerRequestDeadline = Duration.sum(
  Duration.millis(maximumHostedTurnIterations * maximumModelRoundMillis),
  workDeadlineMargin
);

const blankRunnerAdvertisedHostError = (): Config.ConfigError =>
  new Config.ConfigError(
    new ConfigProvider.SourceError({ message: "FIDY_CLUSTER_RUNNER_HOST must not be blank" })
  );

const runnerAdvertisedHost = Config.string("FIDY_CLUSTER_RUNNER_HOST").pipe(
  Config.mapOrFail((host): Effect.Effect<string, Config.ConfigError> => {
    const advertised = host.trim();
    return advertised === ""
      ? Effect.fail(blankRunnerAdvertisedHostError())
      : Effect.succeed(advertised);
  })
);
const runnerPort = Config.port("FIDY_CLUSTER_RUNNER_PORT");
const runnerHostAndPort = Config.all({ host: runnerAdvertisedHost, port: runnerPort });
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
const requireRunnerHosts = (
  hosts: ReadonlyArray<string>
): Effect.Effect<Array.NonEmptyArray<string>, Config.ConfigError> =>
  Option.match(Array.head(hosts), {
    onNone: () => Effect.fail(missingRunnerHostError()),
    onSome: (head) => Effect.succeed(Array.prepend(hosts.slice(1), head)),
  });
const clientRunnerHosts = Config.all({
  advertised: Config.option(runnerAdvertisedHost),
  peers: runnerPeerHosts,
}).pipe(
  Config.mapOrFail(({ advertised, peers }) =>
    requireRunnerHosts(
      Option.match(advertised, {
        onNone: () => peers,
        onSome: (host) => Array.prepend(peers, host),
      })
    )
  )
);
const productionClusterRunnerHttpPolicy = (
  runnerHosts: Array.NonEmptyArray<string>,
  port: number
): ClusterRunnerHttpPolicy => ({
  runnerHosts,
  runnerPorts: [port],
  connectDeadline: productionRunnerConnectDeadline,
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
    const authenticationToken = yield* loadClusterAuthenticationToken;
    return authenticatedClusterHttp.layerSql(
      authenticationToken,
      productionRunnerTopology({ advertisedHost, listenHost, port }).sharding,
      productionClusterRunnerHttpPolicy(Array.prepend(peerHosts, advertisedHost), port)
    );
  })
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
  Layer.provideMerge(Layer.mergeAll(PersistedQueueSqlLive, ProductionWorkflowLive))
);

/** CLI routes through production owners without acquiring shards or creating another local mailbox. */
export const DurableExecutionClientLive = Layer.unwrap(
  Effect.gen(function* () {
    const token = yield* loadClusterAuthenticationToken;
    const hosts = yield* clientRunnerHosts;
    const port = yield* runnerPort;
    return Layer.mergeAll(
      PersistedQueueSqlLive,
      ClusterWorkflowEngine.layer.pipe(
        Layer.provideMerge(
          authenticatedClusterHttp.layerSqlClient(
            token,
            clientClusterTopology().sharding,
            productionClusterRunnerHttpPolicy(hosts, port)
          )
        )
      )
    );
  })
);

/** Volatile native substrate for tests that do not assert process-loss or cross-runtime behavior. */
export const DurableExecutionMemory = Layer.mergeAll(
  VolatilePersistedQueue,
  WorkflowEngine.layerMemory,
  TestRunner.layer,
  ClusterReadinessVolatile
);
