import { Context, Duration, Effect, Layer, Option } from "effect";
import {
  EntityAddress,
  EntityId,
  EntityType,
  MessageStorage,
  RunnerStorage,
  Runners,
  ShardId,
  ShardingConfig,
} from "effect/unstable/cluster";

/** A listening process is only ready when all three independent Cluster abilities answer. */
export type ClusterReadinessReport = Readonly<{
  readonly runnerState: boolean;
  readonly routing: boolean;
  readonly messageStorage: boolean;
}>;

const readinessProbeAddress = EntityAddress.make({
  shardId: ShardId.make("default", 1),
  entityType: EntityType.make("ClusterReadinessProbe"),
  entityId: EntityId.make("readiness"),
});

/** Bound per probe so an unresponsive dependency cannot keep one readiness request open. */
const readinessProbeDeadline = Duration.seconds(2);

/**
 * A readiness endpoint is unauthenticated, so one probe execution serves a short window of
 * requests instead of driving a heartbeat write, an internal RPC, and a mailbox read per hit.
 */
const readinessProbeCacheTtl = Duration.seconds(2);

/**
 * Probe seam that distinguishes a bound HTTP listener from a runner able to do Cluster work. A
 * probe writes this runner's heartbeat (state refresh), pings its advertised address over the
 * private transport (routing), and performs one message-storage lookup (durable mailbox). Every
 * probe contains its own failure and deadline; the report carries booleans only. Concurrent and
 * repeated probes inside the cache window share one execution.
 */
export class ClusterReadiness extends Context.Service<
  ClusterReadiness,
  {
    readonly probe: Effect.Effect<ClusterReadinessReport>;
  }
>()("@fidy/server/shell/cluster-readiness/ClusterReadiness") {
  static readonly layer: Layer.Layer<
    ClusterReadiness,
    never,
    | RunnerStorage.RunnerStorage
    | Runners.Runners
    | MessageStorage.MessageStorage
    | ShardingConfig.ShardingConfig
  > = Layer.effect(
    this,
    Effect.gen(function* () {
      const runnerStorage = yield* RunnerStorage.RunnerStorage;
      const runners = yield* Runners.Runners;
      const messageStorage = yield* MessageStorage.MessageStorage;
      const shardingConfig = yield* ShardingConfig.ShardingConfig;

      // The wrapper turns a completed probe into `true` and an absent, failed, or timed-out probe
      // into `false`, so a degraded ability never exposes an error and never blocks readiness.
      const withProbeDeadline = <A, E, R>(
        probe: Option.Option<Effect.Effect<A, E, R>>
      ): Effect.Effect<boolean, never, R> =>
        Option.match(probe, {
          onNone: () => Effect.succeed(false),
          onSome: (effect) =>
            effect.pipe(
              Effect.timeout(readinessProbeDeadline),
              Effect.as(true),
              Effect.catchCause(() => Effect.succeed(false))
            ),
        });

      const probeRunnerState = withProbeDeadline(
        Option.map(shardingConfig.runnerAddress, (address) => runnerStorage.refresh(address, []))
      );
      const probeRouting = withProbeDeadline(
        Option.map(shardingConfig.runnerAddress, (address) => runners.ping(address))
      );
      const probeMessageStorage = withProbeDeadline(
        Option.some(
          messageStorage.requestIdForPrimaryKey({
            address: readinessProbeAddress,
            tag: "ClusterReadinessProbe",
            id: "readiness",
          })
        )
      );

      return ClusterReadiness.of({
        probe: yield* Effect.cachedWithTTL(
          Effect.all({
            runnerState: probeRunnerState,
            routing: probeRouting,
            messageStorage: probeMessageStorage,
          }),
          readinessProbeCacheTtl
        ),
      });
    })
  );
}

/** Volatile substrate readiness for tests and local compositions without durable Cluster state. */
export const ClusterReadinessVolatile: Layer.Layer<ClusterReadiness> = Layer.succeed(
  ClusterReadiness
)({
  probe: Effect.succeed({ runnerState: true, routing: true, messageStorage: true }),
});
