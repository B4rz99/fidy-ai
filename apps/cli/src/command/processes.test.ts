import { expect, it } from "@effect/vitest";
import { Clock, Deferred, Effect, Exit, Fiber, Option } from "effect";
import { type TestProcess, scopedProcess } from "../../test/process.test-fixture";

it.live("a body deadline escalates a resistant child and completes scoped finalizers", () =>
  Effect.gen(function* () {
    let finalized = false;
    let owned = Option.none<TestProcess>();
    const markFinalized = Effect.sync(() => {
      finalized = true;
    });
    const started = yield* Clock.currentTimeMillis;
    const exit = yield* Effect.gen(function* () {
      yield* Effect.addFinalizer(() => markFinalized);
      const child = yield* scopedProcess([
        process.execPath,
        "-e",
        "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 2500);",
      ]);
      owned = Option.some(child);
      expect(Option.isSome(yield* child.read)).toBe(true);
      yield* child.read.pipe(Effect.timeout(100));
    }).pipe(Effect.scoped, Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(finalized).toBe(true);
    expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(2000);
    const child = Option.getOrThrow(owned);
    expect(yield* child.exited).not.toBe(0);
    expect(Exit.isFailure(yield* Effect.exit(child.read))).toBe(true);
  })
);

it.live("interruption settles the real subprocess and releases its output reader", () =>
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
