import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Cause, Context, Deferred, Effect, Exit, Fiber } from "effect";
import { expect } from "vitest";
import { exitOnAbort } from "./exit-on-abort";

class TurnContext extends Context.Service<TurnContext, { readonly value: string }>()(
  "@fidy/server/cloudflare/agent/internal/exit-on-abort.test/TurnContext"
) {}

it.effect("runs inference with the Turn's services instead of a separate runtime", () => {
  const controller = new AbortController();
  return Effect.gen(function* () {
    const result = yield* exitOnAbort(
      Effect.map(TurnContext, ({ value }) => value),
      controller.signal
    ).pipe(Effect.provideService(TurnContext, { value: "turn-local" }));
    assert.deepStrictEqual(result, Exit.succeed("turn-local"));
  });
});

it.effect(
  "cancels active inference and closes its resource before exposing deadline interruption",
  () => {
    const controller = new AbortController();
    return Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      let closed = false;
      const work = Effect.acquireRelease(Deferred.succeed(ready, undefined), () =>
        Effect.sync(() => {
          closed = true;
        })
      ).pipe(Effect.andThen(Effect.never), Effect.scoped);
      const fiber = yield* exitOnAbort(work, controller.signal).pipe(Effect.forkScoped);
      yield* Deferred.await(ready);
      controller.abort();
      const result = yield* Fiber.join(fiber);
      expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true);
      expect(closed).toBe(true);
    });
  }
);

it.effect("does not start inference after its external deadline has already expired", () => {
  const controller = new AbortController();
  controller.abort();
  return Effect.gen(function* () {
    let started = false;
    const result = yield* exitOnAbort(
      Effect.sync(() => {
        started = true;
      }),
      controller.signal
    );
    expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true);
    expect(started).toBe(false);
  });
});
