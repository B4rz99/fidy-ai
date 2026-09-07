import { expect, it, layer } from "@effect/vitest";
import { Context, Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";
import { RateLimiter } from "effect/unstable/persistence";

const MemoryLimiter = RateLimiter.layer.pipe(Layer.provide(RateLimiter.layerStoreMemory));
const policy = {
  key: "anonymous-source",
  limit: 5,
  window: "1 minute",
  onExceeded: "fail",
} as const;

layer(MemoryLimiter)("stock RateLimiter semantics", (it) => {
  it.effect("does not preserve five-in-any-minute admission with token-bucket refill", () =>
    Effect.gen(function* () {
      const limiter = yield* RateLimiter.RateLimiter;
      for (let attempt = 0; attempt < 5; attempt++) {
        yield* limiter.consume({ ...policy, algorithm: "token-bucket" });
      }
      const rejected = yield* limiter
        .consume({ ...policy, algorithm: "token-bucket" })
        .pipe(Effect.flip);
      expect(rejected.reason._tag).toBe("RateLimitExceeded");
      yield* TestClock.adjust("12 seconds");
      // This sixth admission is valid for a token bucket, but invalid for PATPairing's rolling limit.
      expect((yield* limiter.consume({ ...policy, algorithm: "token-bucket" })).remaining).toBe(0);
    })
  );

  it.effect(
    "expires Effect fixed-window state by consumed-token TTL rather than the rolling window",
    () =>
      Effect.gen(function* () {
        const limiter = yield* RateLimiter.RateLimiter;
        const first = yield* limiter.consume(policy);
        expect(Duration.toMillis(first.resetAfter)).toBe(12_000);
        yield* TestClock.adjust("12 seconds");
        for (let attempt = 0; attempt < 5; attempt++) yield* limiter.consume(policy);
        // Six starts in twelve seconds: the stock fixed-window algorithm is not a sliding log either.
        const rejected = yield* limiter.consume(policy).pipe(Effect.flip);
        expect(rejected.reason._tag).toBe("RateLimitExceeded");
      })
  );
});

it.effect("gives independent memory stores fresh capacity for the same key", () =>
  Effect.gen(function* () {
    for (let instance = 0; instance < 2; instance++) {
      const context = yield* Layer.build(Layer.fresh(MemoryLimiter));
      const limiter = Context.get(context, RateLimiter.RateLimiter);
      for (let attempt = 0; attempt < 5; attempt++) yield* limiter.consume(policy);
      const rejected = yield* limiter.consume(policy).pipe(Effect.flip);
      expect(rejected.reason._tag).toBe("RateLimitExceeded");
    }
    // Ten successes for the same source: local Layer isolation models the reset, not a shared store.
  })
);
