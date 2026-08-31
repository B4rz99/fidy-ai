import { Cause, Effect, Exit, Fiber } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  CardTokenizationFailed,
  type WompiFetch,
  tokenizeCardWithWompi,
} from "./wompi-tokenization";

const card = {
  number: "4242 4242 4242 4242",
  cvc: "123",
  expirationMonth: "8",
  expirationYear: "2030",
  cardholderName: "Ada Lovelace",
};

describe("Wompi browser tokenization", () => {
  it("sends card details straight to Sandbox and retains only the returned token", async () => {
    const fetchStub = vi.fn<WompiFetch>().mockResolvedValue(
      new Response(JSON.stringify({ data: { id: "tok_test_browser_only", brand: "VISA" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    await expect(
      Effect.runPromise(tokenizeCardWithWompi("pub_test_12345678", card, fetchStub))
    ).resolves.toBe("tok_test_browser_only");
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

  it("rejects card networks outside the approved recurring launch set", async () => {
    const fetchStub = vi
      .fn<WompiFetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ data: { id: "tok_test_amex", brand: "AMEX" } }))
      );

    await expect(
      Effect.runPromise(tokenizeCardWithWompi("pub_test_12345678", card, fetchStub))
    ).rejects.toBeInstanceOf(CardTokenizationFailed);
  });

  it.each([
    ["missing content length", {}],
    ["dishonest smaller content length", { "content-length": "1" }],
  ])("stops a chunked %s response at the browser-owned byte limit", async (_label, headers) => {
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

    await expect(
      Effect.runPromise(tokenizeCardWithWompi("pub_test_12345678", card, fetchStub))
    ).rejects.toBeInstanceOf(CardTokenizationFailed);
    expect(cancelled).toBe(true);
  });

  it("rejects a declared oversized response before buffering and cancels its reader", async () => {
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

    await expect(
      Effect.runPromise(tokenizeCardWithWompi("pub_test_12345678", card, fetchStub))
    ).rejects.toBeInstanceOf(CardTokenizationFailed);
    expect(cancelled).toBe(true);
  });

  it("accepts a provider response exactly at the browser-owned byte limit", async () => {
    const body = JSON.stringify({ data: { id: "x".repeat(4_096), brand: "VISA" } });
    const padding = " ".repeat(16_384 - body.length);
    const fetchStub = vi
      .fn<WompiFetch>()
      .mockResolvedValue(new Response(`${body}${padding}`, { status: 200 }));

    await expect(
      Effect.runPromise(tokenizeCardWithWompi("pub_test_12345678", card, fetchStub))
    ).resolves.toBe("x".repeat(4_096));
  });

  it("cancels the provider reader when tokenization is interrupted", async () => {
    const { promise: cancelled, resolve: resolveCancellation } = Promise.withResolvers<void>();
    const fetchStub = vi.fn<WompiFetch>().mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start: (controller): void => controller.enqueue(new Uint8Array([1])),
          pull: (): Promise<void> => new Promise<void>(() => undefined),
          cancel: (): void => resolveCancellation(),
        }),
        { status: 200 }
      )
    );
    const fiber = Effect.runFork(tokenizeCardWithWompi("pub_test_12345678", card, fetchStub));
    await Promise.resolve();

    await Effect.runPromise(Fiber.interrupt(fiber));
    await cancelled;
    const exit = await Effect.runPromise(Fiber.await(fiber));

    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
  });

  it("turns malformed provider responses into one detail-free failure", async () => {
    const fetchStub = vi
      .fn<WompiFetch>()
      .mockResolvedValue(new Response(JSON.stringify({ provider_secret: "unexpected" })));

    await expect(
      Effect.runPromise(tokenizeCardWithWompi("pub_test_12345678", card, fetchStub))
    ).rejects.toBeInstanceOf(CardTokenizationFailed);
  });

  it("cancels an owned response reader on interruption without cleanup defects", async () => {
    const { promise: started, resolve: readingStarted } = Promise.withResolvers<void>();
    const cancel = vi.fn(() => Promise.reject(new Error("reader already closed")));
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull: (): void => readingStarted(),
        cancel,
      })
    );
    const fetchStub = vi.fn<WompiFetch>().mockResolvedValue(response);
    const fiber = Effect.runFork(tokenizeCardWithWompi("pub_test_12345678", card, fetchStub));
    await started;

    await Effect.runPromise(Fiber.interrupt(fiber));
    const exit = await Effect.runPromise(Fiber.await(fiber));

    expect(cancel).toHaveBeenCalledOnce();
    expect(Exit.isFailure(exit) && Cause.hasInterrupts(exit.cause)).toBe(true);
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false);
  });
});
