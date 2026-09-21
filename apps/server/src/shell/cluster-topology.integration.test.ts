import assert from "node:assert/strict";
import { BunServices } from "@effect/platform-bun";
import { loopbackClusterRunnerHttpPolicy } from "~/shell/testing/cluster-runner-http-policy";
import { expect, layer } from "@effect/vitest";
import { describe } from "vitest";
import {
  type Cause,
  Clock,
  Deferred,
  type Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  PrimaryKey,
  Ref,
  Schema,
  Stream,
} from "effect";
import { ClusterWorkflowEngine, EntityId, Sharding, ShardingConfig } from "effect/unstable/cluster";
import { HttpClient } from "effect/unstable/http";
import { type Workflow, type WorkflowEngine } from "effect/unstable/workflow";
import {
  type AuthenticatedClusterLayer,
  authenticatedClusterHttp,
} from "./authenticated-cluster-http";
import { ClusterTopologyIncompatible } from "./cluster-compatibility";
import { ClusterObservationLive, observeClusterTopology } from "./cluster-observation";
import {
  type ClusterRetryCounts,
  projectClusterObservation,
} from "./cluster-observation-projection";
import { sampleClusterObservation } from "./cluster-observation-sample";
import { ClusterReadiness, type ClusterReadinessReport } from "./cluster-readiness";
import { clusterCompatibilityIdentity } from "./cluster-topology";
import { MigrationSqlClient, PgLive } from "~/shell/testing/database-harness";
import {
  clusterLocksTable,
  clusterMessagesTable,
  clusterRunnersTable,
  topologyIdentityTable,
} from "./durable-tables";
import { ApiHarness } from "~/shell/testing/api-harness";
import {
  clusterTestAuthenticationToken,
  clusterTestRunnerOptions,
  clusterTestShardCount,
  clusterTestShardIds,
  clusterTestShardLockExpiration,
  clusterTestShardLockRefreshInterval,
  clusterTestSharedOptions,
  clusterTopologyProbeEntityType,
  clusterTopologyProbeWorkflow,
  clusterTopologyProbeWorkflowLayer,
  disposeTestRuntimes as disposeRuntimes,
  resetClusterTopologyIdentity,
  resetClusterTopologyState,
} from "~/shell/testing/cluster-topology-fixtures";
import { availableLoopbackPort } from "~/shell/testing/network";
import { eventually } from "~/shell/testing/eventually";

const clusterToken = clusterTestAuthenticationToken;
const shardCount = clusterTestShardCount;
const shardIds = clusterTestShardIds;

const [
  observationLoopPort,
  sharingFirstPort,
  sharingSecondPort,
  compatiblePort,
  incompatiblePort,
  gracefulFirstPort,
  gracefulSecondPort,
  lossRunnerPort,
  lossSurvivorPort,
] = await Effect.runPromise(
  Effect.all(
    [
      availableLoopbackPort,
      availableLoopbackPort,
      availableLoopbackPort,
      availableLoopbackPort,
      availableLoopbackPort,
      availableLoopbackPort,
      availableLoopbackPort,
      availableLoopbackPort,
      availableLoopbackPort,
    ],
    { concurrency: "unbounded" }
  )
);
const topologyRunnerPorts: [number, ...number[]] = [
  observationLoopPort,
  sharingFirstPort,
  sharingSecondPort,
  compatiblePort,
  incompatiblePort,
  gracefulFirstPort,
  gracefulSecondPort,
  lossRunnerPort,
  lossSurvivorPort,
];

/** Production-shaped Cluster settings; only leases are tightened so recovery is observable. */
const clusterOptions = {
  ...clusterTestSharedOptions,
  shardLockRefreshInterval: clusterTestShardLockRefreshInterval,
  shardLockExpiration: clusterTestShardLockExpiration,
  runnerHealthCheckInterval: 100,
  refreshAssignmentsInterval: 100,
} satisfies Partial<ShardingConfig.ShardingConfig["Service"]>;

/** Production cadence, proving takeover fits inside the deployment grace budget. */
const productionCadence = {
  entityTerminationTimeout: "15 seconds",
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
  ...clusterTestRunnerOptions({ port, overrides: { ...clusterOptions, ...overrides } }),
});

const runtimeLayer = (
  port: number,
  overrides?: Partial<ShardingConfig.ShardingConfig["Service"]>
): Layer.Layer<
  Layer.Success<AuthenticatedClusterLayer> | Layer.Success<typeof PgLive>,
  Layer.Error<AuthenticatedClusterLayer> | Layer.Error<typeof PgLive>
> =>
  authenticatedClusterHttp
    .layerSql(
      clusterToken,
      runtimeSharding(port, overrides),
      loopbackClusterRunnerHttpPolicy(topologyRunnerPorts)
    )
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
  port: number,
  overrides?: Partial<ShardingConfig.ShardingConfig["Service"]>
): Layer.Layer<
  | Layer.Success<AuthenticatedClusterLayer>
  | Layer.Success<typeof PgLive>
  | WorkflowEngine.WorkflowEngine,
  Layer.Error<AuthenticatedClusterLayer> | Layer.Error<typeof PgLive>
> =>
  clusterTopologyProbeWorkflowLayer.pipe(
    Layer.provideMerge(
      ClusterWorkflowEngine.layer.pipe(Layer.provideMerge(runtimeLayer(port, overrides)))
    )
  );

type WorkRuntime = ManagedRuntime.ManagedRuntime<
  Layer.Success<ReturnType<typeof workRuntimeLayer>>,
  Layer.Error<ReturnType<typeof workRuntimeLayer>>
>;

const makeWorkRuntime = (
  port: number,
  overrides?: Partial<ShardingConfig.ShardingConfig["Service"]>
): WorkRuntime => ManagedRuntime.make(workRuntimeLayer(port, overrides));

/** A runner whose probe stays in flight, making resident Work explicit until shutdown forces it out. */
const makeHeldProbeRuntime = (
  port: number,
  started: Deferred.Deferred<void>,
  overrides: Partial<ShardingConfig.ShardingConfig["Service"]>
): WorkRuntime =>
  ManagedRuntime.make(
    clusterTopologyProbeWorkflow
      .toLayer(() => Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never)))
      .pipe(
        Layer.provideMerge(
          ClusterWorkflowEngine.layer.pipe(Layer.provideMerge(runtimeLayer(port, overrides)))
        )
      )
  );

type SerialProbeControl = Readonly<{
  readonly activeHandlers: Ref.Ref<number>;
  readonly maximumConcurrentHandlers: Ref.Ref<number>;
  readonly handlerCalls: Ref.Ref<number>;
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}>;

const makeSerialProbeLayer = ({
  activeHandlers,
  maximumConcurrentHandlers,
  handlerCalls,
  entered,
  release,
}: SerialProbeControl): Layer.Layer<never, never, WorkflowEngine.WorkflowEngine> =>
  clusterTopologyProbeWorkflow.toLayer(() =>
    Effect.gen(function* () {
      const active = yield* Ref.updateAndGet(activeHandlers, (count) => count + 1);
      yield* Ref.update(maximumConcurrentHandlers, (maximum) => Math.max(maximum, active));
      yield* Ref.update(handlerCalls, (count) => count + 1);
      yield* Deferred.succeed(entered, undefined);
      yield* Deferred.await(release);
      return "recovered";
    }).pipe(Effect.ensuring(Ref.update(activeHandlers, (count) => count - 1)))
  );

const makeSerialProbeRuntime = (
  port: number,
  workflowLayer: Layer.Layer<never, never, WorkflowEngine.WorkflowEngine>
): WorkRuntime =>
  ManagedRuntime.make(
    workflowLayer.pipe(
      Layer.provideMerge(ClusterWorkflowEngine.layer.pipe(Layer.provideMerge(runtimeLayer(port))))
    )
  );

/** Whether the Workflow engine has a completed result for an execution. */
const probeCompleted = (state: Option.Option<Workflow.Result<string, never>>): boolean =>
  Option.exists(state, (result) => result._tag === "Complete");

/** Selects a probe whose Workflow execution shard is held by the requested owner. */
const selectProbe = (
  probeBase: string,
  owner: "local" | ReadonlySet<string>
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
      if (owner === "local" ? sharding.hasShardId(shardId) : owner.has(PrimaryKey.value(shardId))) {
        return { payload, executionId };
      }
    }
    return yield* Effect.die("the selected runner held no shard that accepts a probe");
  });

/** Selects and dispatches a probe against one runner's live assignment map without a stale seam. */
const dispatchLocalProbe = (
  probeBase: string
): Effect.Effect<string, never, Sharding.Sharding | WorkflowEngine.WorkflowEngine> =>
  Effect.flatMap(selectProbe(probeBase, "local"), ({ payload }) =>
    clusterTopologyProbeWorkflow.execute(payload, { discard: true })
  );

const startRuntimes = (runtimes: ReadonlyArray<ClusterRuntime>): Effect.Effect<void> =>
  Effect.forEach(runtimes, (runtime) => Effect.promise(() => runtime.runPromise(Effect.void)), {
    discard: true,
  });

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
  eventually(ready, (value) => value, { interval: "50 millis", timeout }).pipe(Effect.asVoid);

const maximumCrashRunnerOutputBytes = 16_384;

const spawnLossRunner = (port: number): Bun.Subprocess<"ignore", "pipe", "ignore"> =>
  Bun.spawn(
    [
      "bun",
      "src/shell/testing/cluster-topology-crash-runner.ts",
      String(port),
      String(lossSurvivorPort),
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
    }
  );

const killLossRunner = (child: Bun.Subprocess<"ignore", "pipe", "ignore">): Effect.Effect<void> =>
  Effect.sync(() => {
    child.kill("SIGKILL");
  }).pipe(Effect.andThen(Effect.tryPromise(() => child.exited)), Effect.orDie);

/** One sample plus one observation log line, run inside a live runner's context. */
const sampleObservedTopology = Effect.gen(function* () {
  const previousRetries = yield* Ref.make(Option.none<ClusterRetryCounts>());
  const sample = yield* sampleClusterObservation;
  yield* observeClusterTopology(previousRetries);
  return projectClusterObservation({
    sample,
    previousRetries: yield* Ref.get(previousRetries),
  });
});

const registerClusterTopologyScenarios = (): void => {
  layer(ApiHarness, { excludeTestServices: true, timeout: "60 seconds" })("scenarios", (it) => {
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
          yield* resetClusterTopologyIdentity;
          const activeHandlers = yield* Ref.make(0);
          const maximumConcurrentHandlers = yield* Ref.make(0);
          const handlerCalls = yield* Ref.make(0);
          const entered = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const serialProbeLayer = makeSerialProbeLayer({
            activeHandlers,
            maximumConcurrentHandlers,
            handlerCalls,
            entered,
            release,
          });
          const first = makeSerialProbeRuntime(sharingFirstPort, serialProbeLayer);
          const second = makeSerialProbeRuntime(sharingSecondPort, serialProbeLayer);
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
          // Wait until every configured shard has one fresh durable ownership lock, then prove the
          // deployment-wide observation reports no assignment lag.
          yield* waitForCondition(
            Effect.promise(() => first.runPromise(sampleClusterObservation)).pipe(
              Effect.map(
                (sample) =>
                  sample.expectedShards === shardCount &&
                  sample.assignedShards === sample.expectedShards
              )
            )
          );
          const observed = yield* Effect.promise(() => first.runPromise(sampleObservedTopology));
          expect(observed.runnersTotal).toBeGreaterThanOrEqual(2);
          expect(observed.runnersHealthy).toBeGreaterThanOrEqual(2);
          expect(observed.assignedShards).toBe(shardCount);
          expect(observed.expectedShards).toBe(shardCount);
          expect(observed.unassignedShards).toBe(0);
          expect(observed.residentCapacity).toEqual(
            Option.some({ limit: 10_000, pressure: false })
          );

          const serialProbePayload = {
            probe: `shared-owner-${yield* Clock.currentTimeMillis}`,
          };
          const executions = yield* Effect.promise(() =>
            Promise.all([
              first.runPromise(clusterTopologyProbeWorkflow.execute(serialProbePayload)),
              second.runPromise(clusterTopologyProbeWorkflow.execute(serialProbePayload)),
            ])
          ).pipe(Effect.forkChild({ startImmediately: true }));
          yield* Deferred.await(entered);
          yield* Deferred.succeed(release, undefined);
          expect(yield* Fiber.join(executions)).toEqual(["recovered", "recovered"]);
          expect(yield* Ref.get(handlerCalls)).toBe(1);
          expect(yield* Ref.get(maximumConcurrentHandlers)).toBe(1);

          const sql = yield* MigrationSqlClient;
          expect(
            yield* sql`SELECT count(*)::int AS count FROM fidy_durable.${sql(topologyIdentityTable)}`
          ).toEqual([{ count: 1 }]);
          expect(
            yield* sql`SELECT shards_per_group AS "shardsPerGroup",
            available_shard_groups AS "availableShardGroups"
            FROM fidy_durable.${sql(topologyIdentityTable)}`
          ).toEqual([{ shardsPerGroup: shardCount, availableShardGroups: ["default"] }]);
          expect(
            yield* sql`SELECT address, healthy FROM fidy_durable.${sql(clusterRunnersTable)}
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
            FROM fidy_durable.${sql(topologyIdentityTable)}`
        ).toEqual([{ shardsPerGroup: shardCount }]);
      })
    );

    it.effect(
      "hands every shard to the survivor after a graceful shutdown",
      () =>
        Effect.gen(function* () {
          // The production lease window is a different deployment topology than the tightened
          // scenarios, so this scenario publishes its own identity.
          yield* resetClusterTopologyState;
          const firstProbeStarted = yield* Deferred.make<void>();
          const first = makeHeldProbeRuntime(
            gracefulFirstPort,
            firstProbeStarted,
            productionCadence
          );
          const second = makeWorkRuntime(gracefulSecondPort, productionCadence);
          yield* Effect.addFinalizer(() => disposeRuntimes([first, second]));
          yield* Effect.all(
            [
              Effect.promise(() => first.runPromise(Effect.void)),
              Effect.promise(() => second.runPromise(Effect.void)),
            ],
            { discard: true }
          );
          // Production assignment sync is a 3-second tick per phase, so allow several ticks: a
          // loaded runner may stall one while its storage operations time out and retry.
          yield* waitForCondition(
            Effect.promise(() =>
              Promise.all([first.runPromise(ownedShardCount), second.runPromise(ownedShardCount)])
            ).pipe(Effect.map(([firstOwned, secondOwned]) => firstOwned > 0 && secondOwned > 0)),
            "30 seconds"
          );

          const sql = yield* MigrationSqlClient;
          const firstAddress = `127.0.0.1:${gracefulFirstPort}`;
          const gracefulProbeBase = `graceful-${yield* Clock.currentTimeMillis}`;
          yield* Effect.promise(() => first.runPromise(dispatchLocalProbe(gracefulProbeBase)));
          yield* Deferred.await(firstProbeStarted).pipe(Effect.timeout("10 seconds"));
          expect(
            (yield* Effect.promise(() => first.runPromise(sampleClusterObservation)))
              .residentEntities
          ).toBeGreaterThan(0);

          // One configured deployment-drain deadline covers resident-entity termination, disposal,
          // and survivor takeover. Preemptive shutdown must release every lock before lease expiry.
          yield* Effect.promise(() => first.dispose());
          yield* eventually(
            Effect.promise(() => second.runPromise(ownedShardCount)),
            (owned) => owned === shardCount,
            { interval: "50 millis", timeout: "25 seconds" }
          );
          expect(
            yield* sql`SELECT count(*)::int AS count FROM fidy_durable.${sql(clusterLocksTable)}
            WHERE address = ${firstAddress}`
          ).toEqual([{ count: 0 }]);
          expect(
            yield* sql`SELECT count(*)::int AS count FROM fidy_durable.${sql(clusterRunnersTable)}
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
          yield* resetClusterTopologyState;
          const survivor = makeWorkRuntime(lossSurvivorPort);
          yield* Effect.addFinalizer(() => disposeRuntimes([survivor]));
          yield* Effect.promise(() => survivor.runPromise(Effect.void));
          const runner = yield* Effect.acquireRelease(
            Effect.sync(() => spawnLossRunner(lossRunnerPort)),
            killLossRunner
          );
          const stdout = runner.stdout;
          if (!(stdout instanceof ReadableStream)) {
            return yield* Effect.die("Cluster runner stdout pipe was unavailable");
          }
          const output = yield* Stream.fromReadableStream({
            evaluate: () => stdout,
            onError: () => "cluster-runner-output-failed" as const,
          }).pipe(
            Stream.mapEffect((chunk) =>
              Schema.decodeEffect(Schema.Uint8Array)(chunk).pipe(Effect.orDie)
            ),
            Stream.decodeText(),
            Stream.scanEffect(
              () => "",
              (text, chunk) =>
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
            FROM fidy_durable.${sql(clusterLocksTable)} WHERE address = ${crashRunnerAddress}`;
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
              SELECT 1 FROM fidy_durable.${sql(clusterMessagesTable)}
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
              SELECT 1 FROM fidy_durable.${sql(clusterMessagesTable)}
              WHERE entity_type = ${clusterTopologyProbeEntityType}
                AND entity_id = ${probe.executionId} AND processed = FALSE
            ) AS pending`
          ).toEqual([{ pending: false }]);
          expect(
            yield* sql`SELECT count(*)::int AS count FROM fidy_durable.${sql(clusterLocksTable)}
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
  });
};

describe("durable Cluster topology", { concurrent: false }, registerClusterTopologyScenarios);
