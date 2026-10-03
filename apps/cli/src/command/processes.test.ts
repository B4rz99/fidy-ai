import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Option } from "effect";
import { type TestProcess, scopedProcess } from "../../test/process.test-fixture";

it.effect("interruption settles the real subprocess and releases its output reader", () =>
  Effect.gen(function* () {
    const ready = yield* Deferred.make<TestProcess>();
    const fiber = yield* Effect.gen(function* () {
      const child = yield* scopedProcess([
        process.execPath,
        "-e",
        "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
      ]);
      const chunk = yield* child.read;
      expect(Option.isSome(chunk)).toBe(true);
      yield* Deferred.succeed(ready, child);
      yield* child.read;
      return yield* Effect.never;
    }).pipe(Effect.scoped, Effect.forkChild);
    const child = yield* Deferred.await(ready);
    yield* Fiber.interrupt(fiber);
    expect(Number.isInteger(yield* child.exited)).toBe(true);
    expect(Exit.isFailure(yield* Effect.exit(child.read))).toBe(true);
  })
);
