import assert from "node:assert/strict";
import { BunServices } from "@effect/platform-bun";
import { expect, layer } from "@effect/vitest";
import {
  type Cause,
  Clock,
  type Duration,
  Effect,
  Exit,
  Layer,
  ManagedRuntime,
  Option,
  PrimaryKey,
  Ref,
  Schedule,
  Stream,
} from "effect";
import {
  ClusterWorkflowEngine,
  EntityId,
  RunnerAddress,
  Sharding,
  ShardingConfig,
} from "effect/unstable/cluster";
import { HttpClient } from "effect/unstable/http";
import { type Workflow, type WorkflowEngine } from "effect/unstable/workflow";
import {
  type AuthenticatedClusterLayer,
  authenticatedClusterHttp,
} from "./authenticated-cluster-http";
import { ClusterTopologyIncompatible } from "./cluster-compatibility";
import {
  ClusterObservationLive,
  type ClusterRetryCounts,
  observeClusterTopology,
  projectClusterObservation,
  sampleClusterObservation,
} from "./cluster-observation";
import { ClusterReadiness, type ClusterReadinessReport } from "./cluster-readiness";
import { clusterCompatibilityIdentity } from "./cluster-topology";
import { MigrationSqlClient, PgLive } from "~/shell/db/client";
import { ApiHarness } from "~/shell/testing/api-harness";
import {
  clusterTestAuthenticationToken,
  clusterTestShardCount,
  clusterTestShardIds,
  clusterTestSharedOptions,
  clusterTopologyProbeEntityType,
  clusterTopologyProbeWorkflow,
  clusterTopologyProbeWorkflowLayer,
  resetClusterTopologyIdentity,
} from "~/shell/testing/cluster-topology-fixtures";
import { resetClusterTopologyBeforeAll } from "~/shell/testing/cluster-topology-reset";

const clusterToken = clusterTestAuthenticationToken;
const shardCount = clusterTestShardCount;
const shardIds = clusterTestShardIds;

const observationLoopPort = 24701;
const sharingFirstPort = 24702;
const sharingSecondPort = 24703;
const compatiblePort = 24704;
const incompatiblePort = 24705;
const gracefulFirstPort = 24706;
const gracefulSecondPort = 24707;
const lossRunnerPort = 24708;
const lossSurvivorPort = 24709;

/** Production-shaped Cluster settings; only leases are tightened so recovery is observable. */
const clusterOptions = {
  ...clusterTestSharedOptions,
  shardLockRefreshInterval: 250,
  shardLockExpiration: "2 seconds",
  runnerHealthCheckInterval: 100,
  refreshAssignmentsInterval: 100,
} satisfies Partial<ShardingConfig.ShardingConfig["Service"]>;

/** Production cadence, proving takeover fits inside the deployment grace budget. */
const productionCadence = {
  shardLockRefreshInterval: 10_000,
  shardLockExpiration: "35 seconds",
  refreshAssignmentsInterval: "3 seconds",
} satisfies Partial<ShardingConfig.ShardingConfig["Service"]>;

/** The exact Sharding configuration a test runner builds, so scenarios can derive its identity. */
const runtimeSharding = (
  port: number,
  overrides?: Partial<ShardingConfig.ShardingConfig["Service"]>
): ShardingConfig.ShardingConfig["Service"] => ({
  ...ShardingConfig.defaults,
  ...clusterOptions,
  runnerAddress: Option.some(RunnerAddress.make("127.0.0.1", port)),
  runnerListenAddress: Option.some(RunnerAddress.make("127.0.0.1", port)),
  ...overrides,
});

const runtimeLayer = (
  port: number,
  overrides?: Partial<ShardingConfig.ShardingConfig["Service"]>
): Layer.Layer<
  Layer.Success<AuthenticatedClusterLayer> | Layer.Success<typeof PgLive>,
  Layer.Error<AuthenticatedClusterLayer> | Layer.Error<typeof PgLive>
> =>
  authenticatedClusterHttp
    .layerSql(clusterToken, runtimeSharding(port, overrides))
    .pipe(Layer.provideMerge(PgLive), Layer.provide(BunServices.layer));

type ClusterRuntime = ManagedRuntime.ManagedRuntime<
  Layer.Success<AuthenticatedClusterLayer> | Layer.Success<typeof PgLive>,
  Layer.Error<AuthenticatedClusterLayer> | Layer.Error<typeof PgLive>
>;

const makeRuntime = (
  port: number,
  overrides?: Partial<ShardingConfig.ShardingConfig["Service"]>
): ClusterRuntime => ManagedRuntime.make(runtimeLayer(port, overrides));

/**
 * A runner that registers the probe Workflow, so it can complete persisted probe requests after
 * taking over a dead runner's shards.
 */
const workRuntimeLayer = (
  port: number
): Layer.Layer<
  | Layer.Success<AuthenticatedClusterLayer>
  | Layer.Success<typeof PgLive>
  | WorkflowEngine.WorkflowEngine,
  Layer.Error<AuthenticatedClusterLayer> | Layer.Error<typeof PgLive>
> =>
  clusterTopologyProbeWorkflowLayer.pipe(
    Layer.provideMerge(ClusterWorkflowEngine.layer.pipe(Layer.provideMerge(runtimeLayer(port))))
  );

type WorkRuntime = ManagedRuntime.ManagedRuntime<
  Layer.Success<ReturnType<typeof workRuntimeLayer>>,
  Layer.Error<ReturnType<typeof workRuntimeLayer>>
>;

const makeWorkRuntime = (port: number): WorkRuntime => ManagedRuntime.make(workRuntimeLayer(port));

/** Whether the Workflow engine has a completed result for an execution. */
const probeCompleted = (state: Option.Option<Workflow.Result<string, never>>): boolean =>
  Option.exists(state, (result) => result._tag === "Complete");

/** Selects a probe whose Workflow execution shard is held by the doomed runner. */
const selectProbe = (
  probeBase: string,
  lockedShardIds: ReadonlySet<string>
): Effect.Effect<
  { readonly payload: { readonly probe: string }; readonly executionId: string },
  never,
  Sharding.Sharding
> =>
  Effect.gen(function* () {
    const sharding = yield* Sharding.Sharding;
    for (let index = 0; index < 10_000; index += 1) {
      const payload = { probe: `${probeBase}-${index}` };
      const executionId = yield* clusterTopologyProbeWorkflow.executionId(payload);
      const shardId = sharding.getShardId(EntityId.make(executionId), "default");
      if (lockedShardIds.has(PrimaryKey.value(shardId))) {
        return { payload, executionId };
      }
    }
    return yield* Effect.die("the crash runner held no shard that accepts a probe");
  });

type Disposable = Readonly<{ dispose: () => Promise<void> }>;

const startRuntimes = (runtimes: ReadonlyArray<ClusterRuntime>): Effect.Effect<void> =>
  Effect.forEach(runtimes, (runtime) => Effect.promise(() => runtime.runPromise(Effect.void)), {
    discard: true,
  });

const disposeRuntimes = (runtimes: ReadonlyArray<Disposable>): Effect.Effect<void> =>
  Effect.promise(() => Promise.all(runtimes.map((runtime) => runtime.dispose()))).pipe(
    Effect.asVoid
  );

const readinessProbe: Effect.Effect<ClusterReadinessReport, never, ClusterReadiness> =
  Effect.flatMap(ClusterReadiness, (readiness) => readiness.probe);

const ownedShardCount: Effect.Effect<number, never, Sharding.Sharding> = Effect.map(
  Sharding.Sharding,
  (sharding) => shardIds.filter((shardId) => sharding.hasShardId(shardId)).length
);

const waitForCondition = <E, R>(
  ready: Effect.Effect<boolean, E, R>,
  timeout: Duration.Input = "15 seconds"
): Effect.Effect<void, E | Cause.TimeoutError, R> =>
  ready.pipe(
    Effect.repeat({ until: (value) => value, schedule: Schedule.spaced("50 millis") }),
    Effect.asVoid,
    Effect.timeout(timeout)
  );

const maximumCrashRunnerOutputBytes = 16_384;

const spawnLossRunner = (port: number): Bun.Subprocess<"ignore", "pipe", "ignore"> =>
  Bun.spawn(["bun", "src/shell/testing/cluster-topology-crash-runner.ts", String(port)], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });

const killLossRunner = (child: Bun.Subprocess<"ignore", "pipe", "ignore">): Effect.Effect<void> =>
  Effect.sync(() => {
    child.kill("SIGKILL");
  }).pipe(Effect.andThen(Effect.tryPromise(() => child.exited)), Effect.orDie);

/** One sample plus one observation log line, run inside a live runner's context. */
const sampleObservedTopology = Effect.gen(function* () {
  const previousRetries = yield* Ref.make(Option.none<ClusterRetryCounts>());
  const sample = yield* sampleClusterObservation;
  yield* observeClusterTopology(previousRetries);
  return projectClusterObservation(sample, yield* Ref.get(previousRetries));
});

layer(ApiHarness, { excludeTestServices: true, timeout: "60 seconds" })(
  "durable Cluster topology",
  (it) => {
    resetClusterTopologyBeforeAll();

    // Route contract under the harness's in-memory readiness; the SQL-backed probe distinction is
    // asserted on live runners in the multi-runtime scenarios below.
    it.effect("reports readiness as bounded booleans over the public route", () =>
      Effect.gen(function* () {
        const response = yield* HttpClient.get("/ready");
        expect(response.status).toBe(200);
        expect(yield* response.json).toEqual({
          status: "ready",
          checks: { runnerState: true, routing: true, messageStorage: true },
        });
      })
    );

    it.effect(
      "shares one durable identity across compatible runners that both report ready",
      () =>
        Effect.gen(function* () {
          const first = makeRuntime(sharingFirstPort);
          const second = makeRuntime(sharingSecondPort);
          yield* Effect.addFinalizer(() => disposeRuntimes([first, second]));
          yield* startRuntimes([first, second]);
          const [firstReady, secondReady] = yield* Effect.promise(() =>
            Promise.all([first.runPromise(readinessProbe), second.runPromise(readinessProbe)])
          );
          expect(firstReady).toEqual({ runnerState: true, routing: true, messageStorage: true });
          expect(secondReady).toEqual({ runnerState: true, routing: true, messageStorage: true });

          yield* waitForCondition(
            Effect.promise(() =>
              Promise.all([first.runPromise(ownedShardCount), second.runPromise(ownedShardCount)])
            ).pipe(Effect.map(([firstOwned, secondOwned]) => firstOwned > 0 && secondOwned > 0))
          );
          // Wait until the first runner holds every shard the healthy ring assigns it, then prove
          // the observation reports zero assignment lag for that runner.
          yield* waitForCondition(
            Effect.promise(() => first.runPromise(sampleClusterObservation)).pipe(
              Effect.map(
                (sample) =>
                  sample.expectedShards > 0 && sample.assignedShards === sample.expectedShards
              )
            )
          );
          const observed = yield* Effect.promise(() => first.runPromise(sampleObservedTopology));
          expect(observed.runnersTotal).toBeGreaterThanOrEqual(2);
          expect(observed.runnersHealthy).toBeGreaterThanOrEqual(2);
          expect(observed.assignedShards).toBeGreaterThan(0);
          // The ring splits the group across healthy runners, so one runner never expects all shards.
          expect(observed.expectedShards).toBeGreaterThan(0);
          expect(observed.expectedShards).toBeLessThan(shardCount);
          expect(observed.unassignedShards).toBe(0);
          expect(observed.residentCapacity).toEqual(
            Option.some({ limit: 10_000, pressure: false })
          );

          const sql = yield* MigrationSqlClient;
          expect(
            yield* sql`SELECT count(*)::int AS count FROM fidy_durable.cluster_topology_identity`
          ).toEqual([{ count: 1 }]);
          expect(
            yield* sql`SELECT shards_per_group AS "shardsPerGroup",
            available_shard_groups AS "availableShardGroups"
            FROM fidy_durable.cluster_topology_identity`
          ).toEqual([{ shardsPerGroup: shardCount, availableShardGroups: ["default"] }]);
          expect(
            yield* sql`SELECT address, healthy FROM fidy_durable.cluster_runners
            WHERE address IN (${`127.0.0.1:${sharingFirstPort}`}, ${`127.0.0.1:${sharingSecondPort}`})
            ORDER BY address`
          ).toEqual([
            { address: `127.0.0.1:${sharingFirstPort}`, healthy: true },
            { address: `127.0.0.1:${sharingSecondPort}`, healthy: true },
          ]);
        }),
      60_000
    );

    it.effect("refuses a runner whose shard count disagrees with the published identity", () =>
      Effect.gen(function* () {
        const compatible = makeRuntime(compatiblePort);
        yield* Effect.addFinalizer(() => disposeRuntimes([compatible]));
        yield* startRuntimes([compatible]);

        const published = clusterCompatibilityIdentity(runtimeSharding(compatiblePort));
        const exit = yield* Layer.build(
          runtimeLayer(incompatiblePort, { shardsPerGroup: shardCount + 1 })
        ).pipe(
          Effect.scoped,
          Effect.catchTag(["ServeError", "SqlError", "ConfigError"], (clusterError) =>
            Effect.die(clusterError)
          ),
          Effect.exit
        );
        assert.deepStrictEqual(
          exit,
          Exit.fail(
            new ClusterTopologyIncompatible({
              published,
              local: clusterCompatibilityIdentity(
                runtimeSharding(incompatiblePort, { shardsPerGroup: shardCount + 1 })
              ),
              differences: ["shardsPerGroup"],
            })
          )
        );

        const sql = yield* MigrationSqlClient;
        expect(
          yield* sql`SELECT shards_per_group AS "shardsPerGroup"
            FROM fidy_durable.cluster_topology_identity`
        ).toEqual([{ shardsPerGroup: shardCount }]);
      })
    );

    it.effect(
      "hands every shard to the survivor after a graceful shutdown",
      () =>
        Effect.gen(function* () {
          // The production lease window is a different deployment topology than the tightened
          // scenarios, so this scenario publishes its own identity.
          yield* resetClusterTopologyIdentity;
          const first = makeRuntime(gracefulFirstPort, productionCadence);
          const second = makeRuntime(gracefulSecondPort, productionCadence);
          yield* Effect.addFinalizer(() => disposeRuntimes([first, second]));
          yield* startRuntimes([first, second]);
          // Production assignment sync is a 3-second tick per phase, so allow several ticks: a
          // loaded runner may stall one while its storage operations time out and retry.
          yield* waitForCondition(
            Effect.promise(() =>
              Promise.all([first.runPromise(ownedShardCount), second.runPromise(ownedShardCount)])
            ).pipe(Effect.map(([firstOwned, secondOwned]) => firstOwned > 0 && secondOwned > 0)),
            "30 seconds"
          );

          // Preemptive shutdown releases every lock and unregisters, so no lease must expire.
          yield* Effect.promise(() => first.dispose());
          yield* waitForCondition(
            Effect.promise(() => second.runPromise(ownedShardCount)).pipe(
              Effect.map((owned) => owned === shardCount)
            ),
            "30 seconds"
          );
          const firstAddress = `127.0.0.1:${gracefulFirstPort}`;
          const sql = yield* MigrationSqlClient;
          expect(
            yield* sql`SELECT count(*)::int AS count FROM fidy_durable.cluster_locks
            WHERE address = ${firstAddress}`
          ).toEqual([{ count: 0 }]);
          expect(
            yield* sql`SELECT count(*)::int AS count FROM fidy_durable.cluster_runners
            WHERE address = ${firstAddress}`
          ).toEqual([{ count: 0 }]);
        }),
      60_000
    );

    it.effect(
      "recovers every shard and persisted Work after a runner is killed without finalizers",
      () =>
        Effect.gen(function* () {
          // Tightened lease timings are a different deployment topology than the graceful scenario.
          yield* resetClusterTopologyIdentity;
          const survivor = makeWorkRuntime(lossSurvivorPort);
          yield* Effect.addFinalizer(() => disposeRuntimes([survivor]));
          yield* Effect.promise(() => survivor.runPromise(Effect.void));
          const runner = yield* Effect.acquireRelease(
            Effect.sync(() => spawnLossRunner(lossRunnerPort)),
            killLossRunner
          );
          const output = yield* Stream.fromReadableStream({
            evaluate: () => runner.stdout,
            onError: () => "cluster-runner-output-failed" as const,
          }).pipe(
            Stream.decodeText(),
            Stream.scanEffect("", (text, chunk) =>
              text.length + chunk.length > maximumCrashRunnerOutputBytes
                ? Effect.die("Cluster runner output exceeded its bound")
                : Effect.succeed(text + chunk)
            ),
            Stream.takeUntil((text) => text.includes("cluster-runner-ready")),
            Stream.runLast,
            Effect.timeout("15 seconds")
          );
          expect(Option.getOrElse(output, () => "")).toContain("cluster-runner-ready");

          const sql = yield* MigrationSqlClient;
          const crashRunnerAddress = `127.0.0.1:${lossRunnerPort}`;
          const lockedShards = yield* sql`SELECT shard_id AS "shardId"
            FROM fidy_durable.cluster_locks WHERE address = ${crashRunnerAddress}`;
          expect(lockedShards.length).toBeGreaterThan(0);
          const lockedShardIds = new Set(lockedShards.map((row) => String(row.shardId)));

          // Route the probe to a shard the doomed runner holds, so the crash is the only thing that
          // can hand its Work to the survivor.
          const probeBase = `loss-${yield* Clock.currentTimeMillis}`;
          const probe = yield* Effect.promise(() =>
            survivor.runPromise(selectProbe(probeBase, lockedShardIds))
          );

          // The request is written to the durable mailbox before delivery is attempted, and the
          // doomed runner cannot serve the probe entity, so delivery never completes. Abandoning the
          // pending notify keeps the persisted Work as the recovery path under test.
          yield* Effect.promise(() =>
            survivor.runPromise(
              clusterTopologyProbeWorkflow
                .execute(probe.payload, { discard: true })
                .pipe(Effect.timeout("2 seconds"), Effect.exit)
            )
          );
          yield* waitForCondition(
            sql`SELECT EXISTS (
              SELECT 1 FROM fidy_durable.cluster_messages
              WHERE entity_type = ${clusterTopologyProbeEntityType}
                AND entity_id = ${probe.executionId} AND processed = FALSE
            ) AS persisted`.pipe(Effect.map((rows) => rows[0]?.persisted === true))
          );

          // SIGKILL ran no finalizer, so the survivor can only take over once the lease expires.
          runner.kill("SIGKILL");
          yield* Effect.tryPromise(() => runner.exited);
          yield* waitForCondition(
            Effect.promise(() => survivor.runPromise(ownedShardCount)).pipe(
              Effect.map((owned) => owned === shardCount)
            )
          );
          // Recovery means the persisted probe request completes on the survivor and its mailbox
          // row is acknowledged.
          yield* waitForCondition(
            Effect.promise(() =>
              survivor.runPromise(clusterTopologyProbeWorkflow.poll(probe.executionId))
            ).pipe(Effect.map(probeCompleted))
          );
          expect(
            yield* sql`SELECT EXISTS (
              SELECT 1 FROM fidy_durable.cluster_messages
              WHERE entity_type = ${clusterTopologyProbeEntityType}
                AND entity_id = ${probe.executionId} AND processed = FALSE
            ) AS pending`
          ).toEqual([{ pending: false }]);
          expect(
            yield* sql`SELECT count(*)::int AS count FROM fidy_durable.cluster_locks
            WHERE address = ${crashRunnerAddress}`
          ).toEqual([{ count: 0 }]);
        }),
      60_000
    );

    it.effect(
      "closes the observation loop scope while the runner is live",
      () =>
        Layer.build(
          ClusterObservationLive.pipe(Layer.provide(runtimeLayer(observationLoopPort)))
        ).pipe(Effect.scoped),
      60_000
    );
  }
);
