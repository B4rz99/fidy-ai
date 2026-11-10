import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Redacted, Result } from "effect";
import { Base64Url, Hex } from "effect/encoding";
import { afterEach, expect, vi } from "vitest";
import { digestBytes, newId, newSecret, secretDigest } from "./operations";

afterEach(() => vi.restoreAllMocks());

it.effect("keeps persisted SHA-256 bytes and purpose-qualified secret verifiers unchanged", () =>
  Effect.gen(function* () {
    const bytes = yield* digestBytes(new TextEncoder().encode("abc"));
    expect(Hex.encode(bytes)).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    const verifier = yield* secretDigest({ purpose: "pat", value: Redacted.make("abc") });
    expect(Hex.encode(verifier)).toBe(
      "7ed5b8c2a16492bc2548488a50dd9cc33e93bf4523ee3b12578ae9538dac884c"
    );
    const otherPurpose = yield* secretDigest({ purpose: "session", value: Redacted.make("abc") });
    expect(verifier).not.toEqual(otherPurpose);
  })
);

it.effect(
  "generates UUIDs and 256-bit bearer material without depending on the digest service",
  () =>
    Effect.gen(function* () {
      const digest = vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new Error("unavailable"));
      expect(newId()).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
      );
      const first = yield* newSecret;
      const second = yield* newSecret;
      const decoded = Base64Url.decode(Redacted.value(first));
      expect(Result.isSuccess(decoded) && decoded.success.length).toBe(32);
      expect(Redacted.value(first)).not.toBe(Redacted.value(second));
      expect(digest).not.toHaveBeenCalled();
    })
);

it.effect("retains typed platform failure for recoverable digest refusal", () =>
  Effect.gen(function* () {
    vi.spyOn(crypto.subtle, "digest").mockRejectedValue(new Error("unavailable"));
    const bytes = yield* Effect.result(digestBytes(new Uint8Array([1])));
    expect(Result.isFailure(bytes) && bytes.failure._tag).toBe("PlatformError");
    const secret = yield* Effect.result(
      secretDigest({ purpose: "pat", value: Redacted.make("abc") })
    );
    expect(Result.isFailure(secret) && secret.failure._tag).toBe("PlatformError");
  })
);

it.effect("preserves interruption while a platform digest is pending", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const services = yield* Effect.context<never>();
    vi.spyOn(crypto.subtle, "digest").mockImplementation(() =>
      Effect.runPromiseWith(services)(
        Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
      )
    );
    const fiber = yield* Effect.forkChild(digestBytes(new Uint8Array([1])));
    yield* Deferred.await(started);
    yield* Fiber.interrupt(fiber);
    const result = yield* Fiber.await(fiber);
    expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true);
  })
);
