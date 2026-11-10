import { Deferred, Effect, Fiber, Layer } from "effect";
import { Atom, AtomRegistry } from "effect/reactivity";
import { it } from "@effect/vitest";
import { expect, vi } from "vitest";
import { makeFreshQuery, readFreshQuery } from "./fresh-query";

it.live(
  "strict recovery starts a new loader and accepts equal fresh facts instead of an older pending read",
  () =>
    Effect.gen(function* () {
      const older = yield* Deferred.make<void>();
      const newer = yield* Deferred.make<void>();
      let reads = 0;
      let finished = false;
      const query = makeFreshQuery({
        runtime: Atom.runtime(Layer.empty),
        load: Effect.gen(function* () {
          reads += 1;
          yield* Deferred.await(reads === 1 ? older : newer);
          return "same facts";
        }),
      });
      const registry = AtomRegistry.make();
      const unmount = registry.mount(query);
      try {
        yield* Effect.tryPromise(() => vi.waitFor(() => expect(reads).toBe(1)));
        const recovery = yield* readFreshQuery({ registry, query }).pipe(
          Effect.tap((success) =>
            Effect.sync(() => {
              finished = success;
            })
          ),
          Effect.forkChild
        );
        yield* Effect.tryPromise(() => vi.waitFor(() => expect(reads).toBe(2)));
        yield* Deferred.succeed(older, undefined);
        expect(finished).toBe(false);
        yield* Deferred.succeed(newer, undefined);
        yield* Effect.tryPromise(() => vi.waitFor(() => expect(finished).toBe(true)));
        yield* Fiber.join(recovery);
      } finally {
        unmount();
        registry.dispose();
      }
    })
);

it.live(
  "strict rereads accept synchronous identical content and refuse failures despite retained success",
  () =>
    Effect.gen(function* () {
      let failed = false;
      const query = makeFreshQuery({
        runtime: Atom.runtime(Layer.empty),
        load: Effect.suspend(() =>
          failed ? Effect.fail("refused") : Effect.succeed("same facts")
        ),
      });
      const registry = AtomRegistry.make();
      try {
        expect(yield* readFreshQuery({ registry, query })).toBe(true);
        expect(yield* readFreshQuery({ registry, query })).toBe(true);
        failed = true;
        expect(yield* readFreshQuery({ registry, query })).toBe(false);
      } finally {
        registry.dispose();
      }
    })
);

it.live("superseded loader completion cannot certify the requested recovery", () =>
  Effect.gen(function* () {
    const held = yield* Deferred.make<void>();
    let reads = 0;
    const query = makeFreshQuery({
      runtime: Atom.runtime(Layer.empty),
      load: Effect.gen(function* () {
        reads += 1;
        yield* Deferred.await(held);
        return "facts";
      }),
    });
    const registry = AtomRegistry.make();
    try {
      const first = yield* readFreshQuery({ registry, query }).pipe(Effect.forkChild);
      yield* Effect.tryPromise(() => vi.waitFor(() => expect(reads).toBe(1)));
      registry.refresh(query);
      expect(yield* Fiber.join(first)).toBe(false);
    } finally {
      registry.dispose();
    }
  })
);

it.live("a replaced authentication registry never adopts the prior registry's completion", () =>
  Effect.gen(function* () {
    const held = yield* Deferred.make<void>();
    const query = makeFreshQuery({
      runtime: Atom.runtime(Layer.empty),
      load: Deferred.await(held),
    });
    const previous = AtomRegistry.make();
    const current = AtomRegistry.make();
    try {
      const oldRead = yield* readFreshQuery({ registry: previous, query }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      previous.dispose();
      expect(yield* Fiber.join(oldRead)).toBe(false);
      yield* Deferred.succeed(held, undefined);
      expect(yield* readFreshQuery({ registry: current, query })).toBe(true);
    } finally {
      previous.dispose();
      current.dispose();
    }
  })
);

it.live(
  "runtime acquisition failure settles strict recovery without claiming a loader success",
  () =>
    Effect.gen(function* () {
      const query = makeFreshQuery({
        runtime: Atom.runtime(Layer.effectDiscard(Effect.fail("unavailable"))),
        load: Effect.succeed("facts"),
      });
      const registry = AtomRegistry.make();
      try {
        expect(yield* readFreshQuery({ registry, query })).toBe(false);
      } finally {
        registry.dispose();
      }
    })
);
