import { Deferred, Effect, Option } from "effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { prepareQuery } from "./query-preparation";

it.live("fresh entry rereads a retained result and leaves failures available to the view", () =>
  Effect.gen(function* () {
    let reads = 0;
    let failing = false;
    const source = Atom.make(
      Effect.suspend(() => (failing ? Effect.fail("refused") : Effect.succeed(++reads)))
    ).pipe(Atom.setIdleTTL("400 millis"));
    const registry = AtomRegistry.make();
    try {
      yield* Effect.tryPromise(() =>
        prepareQuery({
          registry,
          query: source,
          options: { mode: "cached", signal: Option.none() },
        })
      );
      expect(Option.getOrThrow(AsyncResult.value(registry.get(source)))).toBe(1);
      yield* Effect.tryPromise(() =>
        prepareQuery({
          registry,
          query: source,
          options: { mode: "fresh", signal: Option.none() },
        })
      );
      expect(Option.getOrThrow(AsyncResult.value(registry.get(source)))).toBe(2);
      failing = true;
      yield* Effect.tryPromise(() =>
        prepareQuery({
          registry,
          query: source,
          options: { mode: "fresh", signal: Option.none() },
        })
      );
      expect(AsyncResult.isFailure(registry.get(source))).toBe(true);
    } finally {
      registry.dispose();
    }
  })
);
it.live("cached display remains available while a fresh observation is in flight", () =>
  Effect.gen(function* () {
    let reads = 0;
    let held = false;
    const gate = yield* Deferred.make<void>();
    const source = Atom.make(
      Effect.gen(function* () {
        reads += 1;
        if (held) yield* Deferred.await(gate);
        return reads;
      })
    ).pipe(Atom.setIdleTTL("400 millis"));
    const registry = AtomRegistry.make();
    try {
      yield* Effect.tryPromise(() =>
        prepareQuery({
          registry,
          query: source,
          options: { mode: "cached", signal: Option.none() },
        })
      );
      held = true;
      yield* Effect.tryPromise(() =>
        prepareQuery({
          registry,
          query: source,
          options: { mode: "refresh-display", signal: Option.none() },
        })
      );
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(reads).toBe(2)));
      expect(registry.get(source).waiting).toBe(true);
      expect(Option.getOrThrow(AsyncResult.value(registry.get(source)))).toBe(1);
      yield* Deferred.succeed(gate, undefined);
      expect(yield* AtomRegistry.getResult(registry, source, { suspendOnWaiting: true })).toBe(2);
    } finally {
      registry.dispose();
    }
  })
);
