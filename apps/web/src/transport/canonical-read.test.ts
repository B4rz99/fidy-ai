// @vitest-environment node
import { Effect, Exit } from "effect";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it } from "vitest";
import { makeCanonicalRead } from "./canonical-read";

it("shares the registry result and refreshes only on a subsequent explicit read", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let requests = 0;
      const query = Atom.make(Effect.sync(() => ++requests));
      const registry = AtomRegistry.make();
      const owner = makeCanonicalRead({ registry, query });
      try {
        expect(yield* owner.read).toBe(1);
        expect(requests).toBe(1);
        const current = registry.get(query);
        expect(AsyncResult.isSuccess(current) && current.value).toBe(1);
        expect(yield* owner.read).toBe(2);
        expect(requests).toBe(2);
        const refreshed = registry.get(query);
        expect(AsyncResult.isSuccess(refreshed) && refreshed.value).toBe(2);
      } finally {
        owner.dispose();
        registry.dispose();
      }
    })
  ));

it("refuses reads after the feature lifetime ends without issuing another request", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      let requests = 0;
      const registry = AtomRegistry.make();
      const owner = makeCanonicalRead({
        registry,
        query: Atom.make(Effect.sync(() => ++requests)),
      });
      try {
        yield* owner.read;
        owner.dispose();
        expect(Exit.isFailure(yield* Effect.exit(owner.read))).toBe(true);
        expect(requests).toBe(1);
      } finally {
        registry.dispose();
      }
    })
  ));
