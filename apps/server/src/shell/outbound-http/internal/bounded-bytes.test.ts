import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Option, Stream } from "effect";
import { collectBoundedBytes } from "./bounded-bytes";

it.effect("collects a byte stream exactly at its limit", () =>
  Effect.gen(function* () {
    const bytes = yield* collectBoundedBytes(
      Stream.fromIterable([new Uint8Array([1, 2]), new Uint8Array([3, 4])]),
      4
    );

    expect(bytes).toEqual(Option.some(new Uint8Array([1, 2, 3, 4])));
  })
);

it.effect("stops a byte stream at the first overflowing chunk", () =>
  Effect.gen(function* () {
    let pulls = 0;
    const stream = Stream.fromIterable([
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4, 5]),
      new Uint8Array([6]),
    ]).pipe(Stream.tap(() => Effect.sync(() => (pulls += 1))));

    const bytes = yield* collectBoundedBytes(stream, 4);

    expect(bytes).toEqual(Option.none());
    expect(pulls).toBe(2);
  })
);

it.effect("releases a byte stream when bounded collection is interrupted", () =>
  Effect.gen(function* () {
    let released = false;
    const stream = Stream.fromEffect(Effect.never).pipe(
      Stream.ensuring(Effect.sync(() => (released = true)))
    );
    const fiber = yield* collectBoundedBytes(stream, 4).pipe(
      Effect.forkChild({ startImmediately: true })
    );
    yield* Effect.yieldNow;

    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);

    expect(released).toBe(true);
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  })
);

it.effect("collects fragmented bytes without retaining empty chunks", () =>
  Effect.gen(function* () {
    const chunks = Array.from({ length: 4096 }, (_, index) =>
      index % 2 === 0 ? new Uint8Array(0) : new Uint8Array([index % 256])
    );
    const bytes = yield* collectBoundedBytes(Stream.fromIterable(chunks), 2048);
    expect(Option.isSome(bytes) && bytes.value.byteLength).toBe(2048);
    expect(Option.isSome(bytes) && bytes.value[0]).toBe(1);
    expect(Option.isSome(bytes) && bytes.value[2047]).toBe(255);
  })
);
