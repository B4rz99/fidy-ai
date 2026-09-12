import { expect, it } from "@effect/vitest";
import { Effect, Exit, Option, Ref } from "effect";
import { ClusterError, RunnerAddress, RunnerStorage, ShardId } from "effect/unstable/cluster";
import { ClusterTelemetry, isRequestRetry, observeShardLocks } from "./cluster-telemetry";

const unused = (): Effect.Effect<never> =>
  Effect.die(new Error("this method is not part of the scenario"));
// The class constructor accepts the decoded `unknown` defect; `make` validates the JSON-encoded side.
// @effect-diagnostics-next-line newSchemaClass:off
const lockFailure = new ClusterError.PersistenceError({
  cause: new Error("shard lock storage is unavailable"),
});
const runnerAddress = RunnerAddress.make("runner.internal", 34431);
const shardId = ShardId.make("default", 1);

it.effect("counts lock acquire and refresh failures and records the last refresh success", () =>
  Effect.gen(function* () {
    const telemetry = yield* ClusterTelemetry;
    const releaseCount = yield* Ref.make(0);
    // RunnerStorage cannot be made to fail through its layer, so the service is hand-built: injecting
    // lock-acquisition and refresh failures is the only seam this wrapper can be tested against.
    const failing = observeShardLocks(
      RunnerStorage.RunnerStorage.of({
        register: unused,
        unregister: unused,
        getRunners: Effect.succeed([]),
        setRunnerHealth: unused,
        acquire: () => Effect.fail(lockFailure),
        refresh: () => Effect.fail(lockFailure),
        release: () => Ref.update(releaseCount, (count) => count + 1),
        releaseAll: unused,
      }),
      telemetry
    );

    // The wrapper passes the storage failure through; only the counter is this test's concern.
    expect(Exit.isFailure(yield* failing.acquire(runnerAddress, [shardId]).pipe(Effect.exit))).toBe(
      true
    );
    expect(yield* telemetry.snapshot).toEqual({
      lockFailures: 1,
      lastLockRefreshAtMillis: Option.none(),
      requestRetries: 0,
    });
    expect(Exit.isFailure(yield* failing.refresh(runnerAddress, [shardId]).pipe(Effect.exit))).toBe(
      true
    );
    expect(yield* telemetry.snapshot).toEqual({
      lockFailures: 2,
      lastLockRefreshAtMillis: Option.none(),
      requestRetries: 0,
    });
    expect(yield* failing.getRunners).toEqual([]);
    yield* failing.release(runnerAddress, shardId);
    expect(yield* Ref.get(releaseCount)).toBe(1);

    const succeeding = observeShardLocks(
      RunnerStorage.RunnerStorage.of({
        register: unused,
        unregister: unused,
        getRunners: Effect.succeed([]),
        setRunnerHealth: unused,
        acquire: () => Effect.succeed([]),
        refresh: () => Effect.succeed([shardId]),
        release: unused,
        releaseAll: unused,
      }),
      telemetry
    );
    yield* succeeding.refresh(runnerAddress, [shardId]);
    const afterSuccess = yield* telemetry.snapshot;
    expect(afterSuccess.lockFailures).toBe(2);
    expect(Option.isSome(afterSuccess.lastLockRefreshAtMillis)).toBe(true);

    // A heartbeat-only refresh carries no shard ids; it must not refresh lock recency or fail locks.
    yield* succeeding.refresh(runnerAddress, []);
    yield* failing.refresh(runnerAddress, []).pipe(Effect.exit);
    expect(yield* telemetry.snapshot).toEqual(afterSuccess);
  }).pipe(
    // The telemetry counter is the only service this scenario needs; the test is its entry point.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(ClusterTelemetry.layer)
  )
);

it("counts only retryable request sends as request retries", () => {
  expect(
    isRequestRetry({ messageTag: "OutgoingRequest", errorTag: "EntityNotAssignedToRunner" })
  ).toBe(true);
  expect(isRequestRetry({ messageTag: "OutgoingRequest", errorTag: "RunnerUnavailable" })).toBe(
    true
  );
  expect(isRequestRetry({ messageTag: "OutgoingRequest", errorTag: "PersistenceError" })).toBe(
    false
  );
  expect(isRequestRetry({ messageTag: "OutgoingEnvelope", errorTag: "RunnerUnavailable" })).toBe(
    false
  );
});

it.effect("records request retries beside the lock counters", () =>
  Effect.gen(function* () {
    const telemetry = yield* ClusterTelemetry;
    expect(yield* telemetry.snapshot).toEqual({
      lockFailures: 0,
      lastLockRefreshAtMillis: Option.none(),
      requestRetries: 0,
    });
    yield* telemetry.recordRequestRetry;
    yield* telemetry.recordRequestRetry;
    expect(yield* telemetry.snapshot).toEqual({
      lockFailures: 0,
      lastLockRefreshAtMillis: Option.none(),
      requestRetries: 2,
    });
  }).pipe(
    // The telemetry counter is the only service this scenario needs; the test is its entry point.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(ClusterTelemetry.layer)
  )
);
