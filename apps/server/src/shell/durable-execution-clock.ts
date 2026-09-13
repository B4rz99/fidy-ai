import { DateTime, Duration, Effect } from "effect";
import { DurableClock } from "effect/unstable/workflow";

/**
 * Waits durably until `at`, returning immediately when the deadline has passed.
 * `name` is persisted and must remain stable and unique within the Workflow execution.
 */
export const sleepUntil = Effect.fn("Durable.sleepUntil")(function* (
  name: string,
  at: DateTime.Utc
) {
  const now = yield* DateTime.now;
  // Pin the threshold so every positive wait uses the persisted clock representation.
  yield* DurableClock.sleep({
    name,
    duration: Math.max(0, DateTime.toEpochMillis(at) - DateTime.toEpochMillis(now)),
    inMemoryThreshold: "0 millis",
  });
});

/**
 * Waits durably for `duration`, returning immediately when it is non-positive.
 * `name` is persisted and must remain stable and unique within the Workflow execution. Invalid
 * `Duration.Input` values defect.
 */
export const sleepFor = Effect.fn("Durable.sleepFor")(function* (
  name: string,
  duration: Duration.Input
) {
  // Pin the threshold so every positive wait uses the persisted clock representation.
  yield* DurableClock.sleep({
    name,
    duration: Math.max(0, Duration.toMillis(Duration.fromInputUnsafe(duration))),
    inMemoryThreshold: "0 millis",
  });
});
