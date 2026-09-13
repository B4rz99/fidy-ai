import { expect, layer } from "@effect/vitest";
import { Context, Effect, Layer, Option, Ref } from "effect";
import {
  MessageStorage,
  RunnerAddress,
  RunnerStorage,
  Runners,
  ShardingConfig,
} from "effect/unstable/cluster";
import {
  ClusterReadiness,
  type ClusterReadinessReport,
  ClusterReadinessVolatile,
} from "./cluster-readiness";

const advertisedAddress = RunnerAddress.make("runner.internal", 34431);

/** In-memory Cluster substrate; readiness probes only need each ability to answer. */
const MemoryCluster = Runners.layerNoop.pipe(
  Layer.provideMerge(RunnerStorage.layerMemory),
  Layer.provideMerge(MessageStorage.layerMemory),
  Layer.provideMerge(ShardingConfig.layerDefaults)
);

type ProbeOverrides = Partial<
  Readonly<{
    runnerAddress: Option.Option<RunnerAddress.RunnerAddress>;
    runnerStorage: (
      base: RunnerStorage.RunnerStorage["Service"]
    ) => RunnerStorage.RunnerStorage["Service"];
    runners: (base: Runners.Runners["Service"]) => Runners.Runners["Service"];
    messageStorage: (
      base: MessageStorage.MessageStorage["Service"]
    ) => MessageStorage.MessageStorage["Service"];
  }>
>;

type MemoryClusterServices =
  | RunnerStorage.RunnerStorage
  | Runners.Runners
  | MessageStorage.MessageStorage
  | ShardingConfig.ShardingConfig;

/**
 * Runs the real readiness probe against in-memory services, replacing one ability at a time so
 * each failure branch is exercised without breaking the others.
 */
const probeWith = (
  overrides: ProbeOverrides
): Effect.Effect<ClusterReadinessReport, never, MemoryClusterServices> =>
  Effect.gen(function* () {
    const runnerStorage = yield* RunnerStorage.RunnerStorage;
    const runners = yield* Runners.Runners;
    const messageStorage = yield* MessageStorage.MessageStorage;
    const shardingConfig = yield* ShardingConfig.ShardingConfig;
    return yield* Effect.flatMap(ClusterReadiness, (readiness) => readiness.probe).pipe(
      // This helper is the probe's entry point; the harness owns the in-memory Cluster lifetime.
      // @effect-diagnostics-next-line strictEffectProvide:off
      Effect.provide(ClusterReadiness.layer),
      Effect.provideService(
        RunnerStorage.RunnerStorage,
        overrides.runnerStorage?.(runnerStorage) ?? runnerStorage
      ),
      Effect.provideService(Runners.Runners, overrides.runners?.(runners) ?? runners),
      Effect.provideService(
        MessageStorage.MessageStorage,
        overrides.messageStorage?.(messageStorage) ?? messageStorage
      ),
      Effect.provideService(ShardingConfig.ShardingConfig, {
        ...shardingConfig,
        runnerAddress: overrides.runnerAddress ?? Option.some(advertisedAddress),
      })
    );
  });

layer(MemoryCluster, { excludeTestServices: true })("Cluster readiness probes", (it) => {
  it.effect("reports ready when runner state, routing, and the durable mailbox all answer", () =>
    Effect.gen(function* () {
      const report = yield* probeWith({});
      expect(report).toEqual({ runnerState: true, routing: true, messageStorage: true });
    })
  );

  it.effect(
    "reports runner state unavailable when the runner cannot refresh its registration",
    () =>
      Effect.gen(function* () {
        const report = yield* probeWith({
          runnerStorage: (base) => ({
            ...base,
            refresh: (): Effect.Effect<never> =>
              Effect.die(new Error("runner storage unavailable")),
          }),
        });
        expect(report).toEqual({ runnerState: false, routing: true, messageStorage: true });
      })
  );

  it.effect(
    "reports runner state and routing unavailable when this process advertises no runner address",
    () =>
      Effect.gen(function* () {
        const report = yield* probeWith({ runnerAddress: Option.none() });
        expect(report).toEqual({ runnerState: false, routing: false, messageStorage: true });
      })
  );

  it.effect("reports routing unavailable when the private transport does not answer", () =>
    Effect.gen(function* () {
      const report = yield* probeWith({
        runners: (base) => ({
          ...base,
          ping: (): Effect.Effect<never> => Effect.die(new Error("runner unreachable")),
        }),
      });
      expect(report).toEqual({ runnerState: true, routing: false, messageStorage: true });
    })
  );

  it.effect("reports message storage unavailable when the durable mailbox cannot be read", () =>
    Effect.gen(function* () {
      const report = yield* probeWith({
        messageStorage: (base) => ({
          ...base,
          requestIdForPrimaryKey: (): Effect.Effect<never> =>
            Effect.die(new Error("mailbox unavailable")),
        }),
      });
      expect(report).toEqual({ runnerState: true, routing: true, messageStorage: false });
    })
  );

  it.effect("serves repeated readiness requests from one probe execution", () =>
    Effect.gen(function* () {
      const base = yield* RunnerStorage.RunnerStorage;
      const refreshes = yield* Ref.make(0);
      const counting = RunnerStorage.RunnerStorage.of({
        ...base,
        refresh: (address, shardIds) =>
          Ref.update(refreshes, (count) => count + 1).pipe(
            Effect.andThen(base.refresh(address, shardIds))
          ),
      });

      const report = yield* Effect.scoped(
        Effect.gen(function* () {
          const context = yield* Layer.build(
            ClusterReadiness.layer.pipe(
              Layer.provide(Layer.succeed(RunnerStorage.RunnerStorage, counting))
            )
          );
          const readiness = Context.get(context, ClusterReadiness);
          const probed = yield* readiness.probe;
          // An unauthenticated readiness flood must not write runner state per request.
          yield* readiness.probe;
          yield* readiness.probe;
          return probed;
        })
      );

      expect(report).toEqual({ runnerState: true, routing: true, messageStorage: true });
      expect(yield* Ref.get(refreshes)).toBe(1);
    })
  );
});

layer(ClusterReadinessVolatile)("volatile Cluster readiness", (it) => {
  it.effect("volatile readiness reports every ability without durable Cluster state", () =>
    Effect.gen(function* () {
      const readiness = yield* ClusterReadiness;
      const report = yield* readiness.probe;
      expect(report).toEqual({ runnerState: true, routing: true, messageStorage: true });
    })
  );
});
