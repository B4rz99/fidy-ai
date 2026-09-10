import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";
import { runBestEffortMaintenance } from "./maintenance-schedule";

it.effect("runs best-effort maintenance immediately and then at its declared cadence", () =>
  Effect.gen(function* () {
    const executions = yield* Ref.make(0);
    const started = yield* Deferred.make<void>();
    const work = Ref.updateAndGet(executions, (count) => count + 1).pipe(
      Effect.tap((count) => (count === 1 ? Deferred.succeed(started, undefined) : Effect.void)),
      Effect.asVoid
    );

    const fiber = yield* runBestEffortMaintenance({
      timing: "best-effort",
      cadence: "1 minute",
      work,
    }).pipe(Effect.forkChild({ startImmediately: true }));

    yield* Deferred.await(started);
    expect(yield* Ref.get(executions)).toBe(1);

    yield* TestClock.adjust("59 seconds");
    expect(yield* Ref.get(executions)).toBe(1);

    yield* TestClock.adjust("1 second");
    expect(yield* Ref.get(executions)).toBe(2);

    yield* Fiber.interrupt(fiber);
  })
);
