import { expect, it } from "@effect/vitest";
import { Cause, Clock, Effect, Exit, Option } from "effect";
import { deepStrictEqual } from "node:assert";
import { type TestProcess, scopedProcess } from "../../cli/test/process.test-fixture";
import { cleanupJourney, scopedJourney } from "../e2e/cli-scope.test-fixture";

it.live("journey budget exhaustion settles blocking children before native cleanup", () =>
  Effect.gen(function* () {
    let owned = Option.none<TestProcess>();
    let cleaned = false;
    const logout = Effect.suspend(() => Option.getOrThrow(owned).exited);
    const cleanup = Effect.sync(() => {
      cleaned = true;
    });
    const exit = yield* scopedJourney(
      Effect.gen(function* () {
        yield* Effect.addFinalizer(() => cleanupJourney(logout, cleanup, 100));
        const child = yield* scopedProcess([
          process.execPath,
          "-e",
          "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
        ]);
        owned = Option.some(child);
        expect(Option.isSome(yield* child.read)).toBe(true);
        yield* child.read;
      }),
      200
    ).pipe(Effect.exit);
    deepStrictEqual(exit, Exit.fail(new Cause.TimeoutError("Operation timed out after '200ms'")));
    expect(cleaned).toBe(true);
    const child = Option.getOrThrow(owned);
    expect(Number.isInteger(yield* child.exited)).toBe(true);
    expect(Exit.isFailure(yield* Effect.exit(child.read))).toBe(true);
  })
);

it.live("a blocked logout is killed and deletion still runs without hiding cleanup failure", () =>
  Effect.gen(function* () {
    let owned = Option.none<TestProcess>();
    let deletionAttempted = false;
    let cleanupOwned = Option.none<TestProcess>();
    const started = yield* Clock.currentTimeMillis;
    const exit = yield* cleanupJourney(
      Effect.gen(function* () {
        const child = yield* scopedProcess([
          process.execPath,
          "-e",
          "process.on('SIGTERM', () => {}); process.stdout.write('ready\\n'); setInterval(() => {}, 1000); setTimeout(() => process.exit(0), 2500);",
        ]);
        owned = Option.some(child);
        expect(Option.isSome(yield* child.read)).toBe(true);
        yield* child.exited;
      }),
      Effect.gen(function* () {
        deletionAttempted = true;
        const child = yield* scopedProcess([
          process.execPath,
          "-e",
          "process.stdout.write('ready\\n'); setInterval(() => {}, 1000);",
        ]);
        cleanupOwned = Option.some(child);
        expect(Option.isSome(yield* child.read)).toBe(true);
        yield* child.exited;
      }),
      200
    ).pipe(Effect.uninterruptible, Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(deletionAttempted).toBe(true);
    const cleanupChild = Option.getOrThrow(cleanupOwned);
    expect(Number.isInteger(yield* cleanupChild.exited)).toBe(true);
    expect(Exit.isFailure(yield* Effect.exit(cleanupChild.read))).toBe(true);
    expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(2000);
    const child = Option.getOrThrow(owned);
    expect(yield* child.exited).not.toBe(0);
    expect(Exit.isFailure(yield* Effect.exit(child.read))).toBe(true);
  })
);
