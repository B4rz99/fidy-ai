import { Cause, Deferred, Effect, Exit, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import { it as effectIt } from "@effect/vitest";
import { describe, expect, it, vi } from "vitest";
import {
  CardTokenizationFailed,
  type WompiFetch,
  tokenizeCardWithWompi,
} from "./wompi-tokenization";

const holdFetch = (signal: AbortSignal): Promise<Response> =>
  Effect.runPromise(Effect.never, { signal });
const neverCancellation = Promise.withResolvers<void>().promise;

const card = {
  number: "4242 4242 4242 4242",
  cvc: "123",
  expirationMonth: "8",
  expirationYear: "2030",
  cardholderName: "Ada Lovelace",
};

describe("Wompi browser tokenization", () => {
  it("sends card details straight to Sandbox and retains only the returned token", () => {
    const fetchStub = vi.fn<WompiFetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "tok_test_browser_only", brand: "VISA" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    return expect(Effect.runPromise(tokenizeCardWithWompi("pub_test_12345678", card, fetchStub)))
      .resolves.toBe("tok_test_browser_only")
      .then(() => {
        expect(fetchStub).toHaveBeenCalledWith(
          "https://sandbox.wompi.co/v1/tokens/cards",
          expect.objectContaining({
            method: "POST",
            body: JSON.stringify({
              number: "4242424242424242",
              cvc: "123",
              exp_month: "08",
              exp_year: "30",
              card_holder: "Ada Lovelace",
            }),
          })
        );
      });
  });

  it("uses the production Wompi origin for production public keys", () => {
    const fetchStub = vi
      .fn<WompiFetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { id: "tok_prod_browser_only", brand: "VISA" } }))
      );

    return expect(Effect.runPromise(tokenizeCardWithWompi("pub_prod_12345678", card, fetchStub)))
      .resolves.toBe("tok_prod_browser_only")
      .then(() => {
        expect(fetchStub).toHaveBeenCalledWith(
          "https://production.wompi.co/v1/tokens/cards",
          expect.any(Object)
        );
      });
  });

  it("fails without calling Wompi when the public key has an unknown environment", () => {
    const fetchStub = vi.fn<WompiFetch>();

    return expect(Effect.runPromise(tokenizeCardWithWompi("pub_unknown_12345678", card, fetchStub)))
      .rejects.toBeInstanceOf(CardTokenizationFailed)
      .then(() => {
        expect(fetchStub).not.toHaveBeenCalled();
      });
  });

  it("turns provider connection failures into one detail-free failure", () => {
    const fetchStub = vi.fn<WompiFetch>().mockRejectedValue(new Error("provider detail"));

    return expect(
      Effect.runPromise(tokenizeCardWithWompi("pub_test_12345678", card, fetchStub))
    ).rejects.toBeInstanceOf(CardTokenizationFailed);
  });

  it("rejects a successful provider response without a body", () => {
    const fetchStub = vi.fn<WompiFetch>().mockResolvedValue(new Response(null, { status: 200 }));

    return expect(
      Effect.runPromise(tokenizeCardWithWompi("pub_test_12345678", card, fetchStub))
    ).rejects.toBeInstanceOf(CardTokenizationFailed);
  });

  it("rejects card networks outside the approved recurring launch set", () => {
    const fetchStub = vi
      .fn<WompiFetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { id: "tok_test_amex", brand: "AMEX" } }))
      );

    return expect(
      Effect.runPromise(tokenizeCardWithWompi("pub_test_12345678", card, fetchStub))
    ).rejects.toBeInstanceOf(CardTokenizationFailed);
  });

  it.each([
    ["missing content length", {}],
    ["dishonest smaller content length", { "content-length": "1" }],
  ])("stops a chunked %s response at the browser-owned byte limit", (_label, headers) => {
    let cancelled = false;
    const fetchStub = vi.fn<WompiFetch>().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller): void => {
            controller.enqueue(new Uint8Array(16_000));
            controller.enqueue(new Uint8Array(385));
          },
          cancel: (): void => {
            cancelled = true;
          },
        }),
        { status: 200, headers }
      )
    );

    return expect(Effect.runPromise(tokenizeCardWithWompi("pub_test_12345678", card, fetchStub)))
      .rejects.toBeInstanceOf(CardTokenizationFailed)
      .then(() => {
        expect(cancelled).toBe(true);
      });
  });

  it("rejects a declared oversized response before buffering and cancels its reader", () => {
    let cancelled = false;
    const fetchStub = vi.fn<WompiFetch>().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller): void => controller.enqueue(new Uint8Array([1])),
          cancel: (): void => {
            cancelled = true;
          },
        }),
        { status: 200, headers: { "content-length": "16385" } }
      )
    );

    return expect(Effect.runPromise(tokenizeCardWithWompi("pub_test_12345678", card, fetchStub)))
      .rejects.toBeInstanceOf(CardTokenizationFailed)
      .then(() => {
        expect(cancelled).toBe(true);
      });
  });

  it("accepts a provider response exactly at the browser-owned byte limit", () => {
    const body = JSON.stringify({ data: { id: "x".repeat(4_096), brand: "VISA" } });
    const padding = " ".repeat(16_384 - body.length);
    const fetchStub = vi
      .fn<WompiFetch>()
      .mockResolvedValue(new Response(`${body}${padding}`, { status: 200 }));

    return expect(
      Effect.runPromise(tokenizeCardWithWompi("pub_test_12345678", card, fetchStub))
    ).resolves.toBe("x".repeat(4_096));
  });

  effectIt.effect("cancels the provider reader when tokenization is interrupted", () =>
    Effect.gen(function* () {
      const { promise: cancelled, resolve: resolveCancellation } = Promise.withResolvers<void>();
      const { promise: neverPull } = Promise.withResolvers<void>();
      const fetchStub = vi.fn<WompiFetch>().mockResolvedValue(
        new Response(
          new ReadableStream<Uint8Array>({
            start: (controller): void => controller.enqueue(new Uint8Array([1])),
            pull: (): Promise<void> => neverPull,
            cancel: (): void => resolveCancellation(),
          }),
          { status: 200 }
        )
      );
      const fiber = yield* Effect.forkChild(
        tokenizeCardWithWompi("pub_test_12345678", card, fetchStub),
        { startImmediately: true }
      );
      yield* Effect.tryPromise(() => Promise.resolve());

      yield* Fiber.interrupt(fiber);
      yield* Effect.tryPromise(() => cancelled);
      const exit = yield* Fiber.await(fiber);

      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    })
  );

  it("turns malformed provider responses into one detail-free failure", () => {
    const fetchStub = vi
      .fn<WompiFetch>()
      .mockResolvedValue(new Response(JSON.stringify({ provider_secret: "unexpected" })));

    return expect(
      Effect.runPromise(tokenizeCardWithWompi("pub_test_12345678", card, fetchStub))
    ).rejects.toBeInstanceOf(CardTokenizationFailed);
  });

  effectIt.effect("cancels an owned response reader on interruption without cleanup defects", () =>
    Effect.gen(function* () {
      const { promise: started, resolve: readingStarted } = Promise.withResolvers<void>();
      const cancel = vi.fn(() => Promise.reject(new Error("reader already closed")));
      const response = new Response(
        new ReadableStream<Uint8Array>({
          pull: (): void => readingStarted(),
          cancel,
        })
      );
      const fetchStub = vi.fn<WompiFetch>().mockResolvedValue(response);
      const fiber = yield* Effect.forkChild(
        tokenizeCardWithWompi("pub_test_12345678", card, fetchStub),
        { startImmediately: true }
      );
      yield* Effect.tryPromise(() => started);

      yield* Fiber.interrupt(fiber);
      const exit = yield* Fiber.await(fiber);

      expect(cancel).toHaveBeenCalledOnce();
      expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
      expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false);
    })
  );

  effectIt.effect("bounds stalled tokenization headers and aborts the native request", () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      let signal = Option.none<AbortSignal>();
      const fetchStub: WompiFetch = (_input, init) => {
        signal = Option.fromNullishOr(init?.signal);
        Deferred.doneUnsafe(ready, Effect.void);
        return holdFetch(Option.getOrThrow(signal));
      };
      const fiber = yield* tokenizeCardWithWompi("pub_test_12345678", card, fetchStub).pipe(
        Effect.exit,
        Effect.forkScoped
      );
      yield* Deferred.await(ready);
      yield* TestClock.adjust("15 seconds");
      const exit = yield* Fiber.join(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBeInstanceOf(
          CardTokenizationFailed
        );
      }
      expect(Option.getOrThrow(signal).aborted).toBe(true);
    }).pipe(Effect.scoped)
  );

  effectIt.effect(
    "bounds body consumption and unlocks its reader even when cancellation never settles",
    () =>
      Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        let signal = Option.none<AbortSignal>();
        let cancelled = false;
        const response = new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              controller.enqueue(new Uint8Array([123]));
            },
            pull(): Promise<void> {
              Deferred.doneUnsafe(ready, Effect.void);
              return neverCancellation;
            },
            cancel(): Promise<void> {
              cancelled = true;
              return neverCancellation;
            },
          })
        );
        const fetchStub: WompiFetch = (_input, init) => {
          signal = Option.fromNullishOr(init?.signal);
          return Promise.resolve(response);
        };
        const fiber = yield* tokenizeCardWithWompi("pub_test_12345678", card, fetchStub).pipe(
          Effect.exit,
          Effect.forkScoped
        );
        yield* Deferred.await(ready);
        yield* TestClock.adjust("15 seconds");
        const exit = yield* Fiber.join(fiber);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBeInstanceOf(
            CardTokenizationFailed
          );
        }
        expect(cancelled).toBe(true);
        expect(response.body?.locked).toBe(false);
        expect(Option.getOrThrow(signal).aborted).toBe(true);
      }).pipe(Effect.scoped)
  );
});
