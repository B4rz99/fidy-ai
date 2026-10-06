import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Option } from "effect";
import { expect, vi } from "vitest";
import publicWorker from "./public-worker";

const holdForwarding = (signal: AbortSignal): Promise<Response> =>
  Effect.runPromise(Effect.never, { signal });

const environment = (
  fetch: Parameters<typeof publicWorker.fetch>[1]["CORE"]["fetch"]
): Parameters<typeof publicWorker.fetch>[1] => ({
  BROWSER_ORIGIN: "https://app.fidyapp.com",
  LOCAL_CANONICAL_READ_BEARER: "",
  PAT_ADMISSION_KEY: "test-only-admission-key-with-32-bytes",
  RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
  CORE: { fetch },
});

it.effect("does not forward an already-aborted public request", () => {
  const controller = new AbortController();
  controller.abort();
  return Effect.gen(function* () {
    const fetch = vi.fn(() => Promise.resolve(new Response()));
    const exit = yield* Effect.tryPromise(() =>
      publicWorker.fetch(
        new Request("https://api.fidyapp.com/categories", {
          signal: controller.signal,
          headers: {
            authorization: "Bearer fin_abcdefgh_" + "x".repeat(43),
            "cf-connecting-ip": "192.0.2.35",
          },
        }),
        environment(fetch)
      )
    ).pipe(Effect.exit);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});

it.effect("connects pending Core forwarding to the original public request's cancellation", () => {
  const controller = new AbortController();
  return Effect.gen(function* () {
    const ready = yield* Deferred.make<void>();
    let forwardingSignal = Option.none<AbortSignal>();
    const env = environment((_request, init) => {
      forwardingSignal = Option.fromNullishOr(init?.signal);
      Deferred.doneUnsafe(ready, Effect.void);
      return holdForwarding(Option.getOrThrow(forwardingSignal));
    });
    const fiber = yield* Effect.tryPromise(() =>
      publicWorker.fetch(
        new Request("https://api.fidyapp.com/categories", {
          signal: controller.signal,
          headers: {
            authorization: "Bearer fin_abcdefgh_" + "x".repeat(43),
            "cf-connecting-ip": "192.0.2.35",
          },
        }),
        env
      )
    ).pipe(Effect.exit, Effect.forkScoped);
    yield* Deferred.await(ready);
    controller.abort();
    const exit = yield* Fiber.join(fiber);
    expect(Exit.isFailure(exit)).toBe(true);
    expect(Option.getOrThrow(forwardingSignal).aborted).toBe(true);
  }).pipe(Effect.scoped);
});
