import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { ShardId } from "effect/unstable/cluster";
import { ClusterTelemetry, isRequestRetry, retainedEveryShard } from "./cluster-telemetry";

it("distinguishes complete lock refresh from partial ownership loss", () => {
  const first = ShardId.make("default", 1);
  const second = ShardId.make("default", 2);
  expect(retainedEveryShard({ requested: [first, second], refreshed: [second, first] })).toBe(true);
  expect(retainedEveryShard({ requested: [first, second], refreshed: [first] })).toBe(false);
  expect(retainedEveryShard({ requested: [first], refreshed: [second] })).toBe(false);
});

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
    // ClusterTelemetry is the public process-local counter interface under test.
    // @effect-diagnostics-next-line strictEffectProvide:off
    Effect.provide(ClusterTelemetry.layer)
  )
);
