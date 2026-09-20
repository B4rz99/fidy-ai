import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";
import { eventually } from "./eventually";

it.effect("re-observes live state at the bounded policy cadence", () =>
  Effect.gen(function* () {
    const observations = yield* Ref.make(0);
    const result = yield* eventually(
      Ref.updateAndGet(observations, (count) => count + 1),
      (count) => count === 3,
      { interval: "10 millis", timeout: "1 second" }
    ).pipe(Effect.forkChild({ startImmediately: true }));

    yield* TestClock.adjust("20 millis");

    expect(yield* Fiber.join(result)).toBe(3);
  })
);
