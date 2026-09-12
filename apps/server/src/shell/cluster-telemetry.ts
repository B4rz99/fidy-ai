import { Clock, Context, Effect, Function, Layer, Option, Ref } from "effect";
import {
  type MessageStorage,
  RunnerStorage,
  Runners,
  type ShardingConfig,
  SqlRunnerStorage,
} from "effect/unstable/cluster";
import { type SqlClient, type SqlError } from "effect/unstable/sql";

/** Process-local counters and recency evidence about this runner's Cluster ownership traffic. */
export type ClusterTelemetrySnapshot = Readonly<{
  readonly lockFailures: number;
  readonly lastLockRefreshAtMillis: Option.Option<number>;
  readonly requestRetries: number;
}>;

/**
 * Records whether shard-lock acquisition and shard-carrying refreshes succeed, and how many
 * cross-runner requests Sharding retried. The Sharding runtime logs an error and drops local
 * ownership when lock storage fails, so this seam retains a bounded failure count and the age of the
 * last successful refresh; the retry counter tells a settling hand-over from a topology that cannot
 * route requests. No counter carries an address, message, or entity identity.
 */
export class ClusterTelemetry extends Context.Service<
  ClusterTelemetry,
  {
    readonly recordLockRefreshSuccess: Effect.Effect<void>;
    readonly recordLockFailure: Effect.Effect<void>;
    readonly recordRequestRetry: Effect.Effect<void>;
    readonly snapshot: Effect.Effect<ClusterTelemetrySnapshot>;
  }
>()("@fidy/server/shell/cluster-telemetry/ClusterTelemetry") {
  static readonly layer: Layer.Layer<ClusterTelemetry> = Layer.effect(
    this,
    Effect.gen(function* () {
      const lockFailures = yield* Ref.make(0);
      const lastLockRefreshAtMillis = yield* Ref.make(Option.none<number>());
      const requestRetries = yield* Ref.make(0);
      return ClusterTelemetry.of({
        recordLockRefreshSuccess: Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) => Ref.set(lastLockRefreshAtMillis, Option.some(now)))
        ),
        recordLockFailure: Ref.update(lockFailures, (count) => count + 1),
        recordRequestRetry: Ref.update(requestRetries, (count) => count + 1),
        snapshot: Effect.all({
          lockFailures: Ref.get(lockFailures),
          lastLockRefreshAtMillis: Ref.get(lastLockRefreshAtMillis),
          requestRetries: Ref.get(requestRetries),
        }),
      });
    })
  );
}

/**
 * Wraps runner storage so shard-lock acquisition and refresh failures become telemetry. A refresh
 * that carries no shard ids only writes the runner heartbeat — the readiness probe uses it — and is
 * left uncounted so heartbeat traffic cannot fake lock-refresh recency. Every other operation
 * passes through unchanged; Sharding keeps the same storage semantics.
 */
export const observeShardLocks: {
  (
    telemetry: ClusterTelemetry["Service"]
  ): (storage: RunnerStorage.RunnerStorage["Service"]) => RunnerStorage.RunnerStorage["Service"];
  (
    storage: RunnerStorage.RunnerStorage["Service"],
    telemetry: ClusterTelemetry["Service"]
  ): RunnerStorage.RunnerStorage["Service"];
} = Function.dual(
  2,
  (
    storage: RunnerStorage.RunnerStorage["Service"],
    telemetry: ClusterTelemetry["Service"]
  ): RunnerStorage.RunnerStorage["Service"] => {
    const observedRefresh: typeof storage.refresh = (address, shardIds) => {
      const shards = Array.from(shardIds);
      return shards.length === 0
        ? storage.refresh(address, shards)
        : storage.refresh(address, shards).pipe(
            Effect.tap(() => telemetry.recordLockRefreshSuccess),
            Effect.tapError(() => telemetry.recordLockFailure)
          );
    };
    const observedAcquire: typeof storage.acquire = (address, shardIds) =>
      storage.acquire(address, shardIds).pipe(Effect.tapError(() => telemetry.recordLockFailure));
    return RunnerStorage.RunnerStorage.of({
      register: storage.register,
      unregister: storage.unregister,
      getRunners: storage.getRunners,
      setRunnerHealth: storage.setRunnerHealth,
      acquire: observedAcquire,
      refresh: observedRefresh,
      release: storage.release,
      releaseAll: storage.releaseAll,
    });
  }
);

/** SQL runner storage with lock acquire and shard-carrying refresh telemetry attached. */
export const shardLockStorageLayer = (options: {
  readonly prefix: string;
}): Layer.Layer<
  RunnerStorage.RunnerStorage,
  SqlError.SqlError,
  SqlClient.SqlClient | ShardingConfig.ShardingConfig | ClusterTelemetry
> =>
  Layer.effect(RunnerStorage.RunnerStorage)(
    Effect.gen(function* () {
      const storage = yield* RunnerStorage.RunnerStorage;
      const telemetry = yield* ClusterTelemetry;
      return observeShardLocks(storage, telemetry);
    })
  ).pipe(Layer.provide(SqlRunnerStorage.layerWith({ prefix: options.prefix })));

/**
 * Error tags the runner client raises for a request call, derived from the service so a renamed tag
 * stops compiling instead of silently stopping the retry counter.
 */
type RunnerCallErrorTag =
  Effect.Error<ReturnType<Runners.Runners["Service"]["send"]>> extends {
    readonly _tag: infer Tag;
  }
    ? Tag
    : never;

/**
 * Whether Sharding will retry this failed send or notification. Only entity requests are counted;
 * envelopes and control messages are not operator-facing request retries, and other error tags do
 * not reach the retry loop.
 */
export const isRequestRetry = (send: {
  readonly messageTag: "OutgoingRequest" | "OutgoingEnvelope";
  readonly errorTag: RunnerCallErrorTag;
}): boolean =>
  send.messageTag === "OutgoingRequest" &&
  (send.errorTag === "EntityNotAssignedToRunner" || send.errorTag === "RunnerUnavailable");

/**
 * Wraps the runner client so a request call that failed with a retryable routing error is counted.
 * Methods are forwarded explicitly, so a new upstream `Runners` method fails to compile here instead
 * of silently bypassing the counter; every passing call passes through unchanged. Persisted Work
 * completes through durable redelivery rather than an in-flight retry, so its pressure is visible as
 * mailbox redeliveries and depth instead of this counter.
 */
export const observeRequestRetries: {
  (
    telemetry: ClusterTelemetry["Service"]
  ): (runners: Runners.Runners["Service"]) => Runners.Runners["Service"];
  (
    runners: Runners.Runners["Service"],
    telemetry: ClusterTelemetry["Service"]
  ): Runners.Runners["Service"];
} = Function.dual(
  2,
  (
    runners: Runners.Runners["Service"],
    telemetry: ClusterTelemetry["Service"]
  ): Runners.Runners["Service"] => {
    const recordRetry = (
      messageTag: "OutgoingRequest" | "OutgoingEnvelope",
      errorTag: RunnerCallErrorTag
    ): Effect.Effect<void> =>
      isRequestRetry({ messageTag, errorTag }) ? telemetry.recordRequestRetry : Effect.void;
    const send: Runners.Runners["Service"]["send"] = (options) => {
      const messageTag = options.message._tag;
      return runners
        .send(options)
        .pipe(Effect.tapError((error) => recordRetry(messageTag, error._tag)));
    };
    const notify: Runners.Runners["Service"]["notify"] = (options) => {
      const messageTag = options.message._tag;
      return runners
        .notify(options)
        .pipe(Effect.tapError((error) => recordRetry(messageTag, error._tag)));
    };
    return {
      ping: runners.ping,
      sendLocal: runners.sendLocal,
      send,
      notify,
      notifyLocal: runners.notifyLocal,
      onRunnerUnavailable: runners.onRunnerUnavailable,
    };
  }
);

/**
 * The Cluster runner client whose request calls feed retry telemetry. It replaces the plain
 * `Runners.layerRpc` inside the runner server, so Sharding routes through the observed client.
 */
export const requestRetryRunnersLive: Layer.Layer<
  Runners.Runners,
  never,
  | MessageStorage.MessageStorage
  | Runners.RpcClientProtocol
  | ShardingConfig.ShardingConfig
  | ClusterTelemetry
> = Layer.effect(
  Runners.Runners,
  Effect.gen(function* () {
    const runners = yield* Runners.Runners;
    const telemetry = yield* ClusterTelemetry;
    return observeRequestRetries(runners, telemetry);
  })
).pipe(Layer.provide(Runners.layerRpc));
