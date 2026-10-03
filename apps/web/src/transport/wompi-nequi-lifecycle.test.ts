import { it as effectIt } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { expect, it, vi } from "vitest";
import { authorizeNequiWithWompi } from "./wompi-nequi";

const tokenResponse = (
  status: "PENDING" | "APPROVED" | "DECLINED" | "ERROR",
  id = "nequi_test_example"
): Response => Response.json({ data: { id, status } });

it.each([
  { publicKey: "invalid", phoneNumber: "3991111111" },
  { publicKey: "pub_test_example", phoneNumber: "123" },
])("rejects invalid authorization input before provider egress: $publicKey/$phoneNumber", (input) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const provider = vi.fn(() => Promise.resolve(tokenResponse("APPROVED")));
      const result = yield* Effect.exit(
        authorizeNequiWithWompi({
          ...input,
          phoneNumber: Redacted.make(input.phoneNumber),
          fetchImplementation: provider,
          onAwaiting: () => undefined,
        })
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(provider).not.toHaveBeenCalled();
    })
  )
);

it.each([
  { name: "declined", response: (): Response => tokenResponse("DECLINED") },
  { name: "provider error", response: (): Response => tokenResponse("ERROR") },
  { name: "invalid JSON", response: (): Response => new Response("CANARY-provider-body") },
  {
    name: "HTTP rejection with a body",
    response: (): Response => new Response("CANARY-provider-body", { status: 403 }),
  },
  {
    name: "HTTP rejection without a body",
    response: (): Response => new Response(null, { status: 403 }),
  },
  {
    name: "failed body cancellation",
    response: (): Response =>
      new Response(
        new ReadableStream({
          cancel: (): Promise<void> => Promise.reject(new Error("CANARY-cancel")),
        }),
        { status: 403 }
      ),
  },
])("fails closed without reflecting $name", ({ response }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const phoneNumber = Redacted.make("3991111111");
      const result = yield* Effect.exit(
        authorizeNequiWithWompi({
          publicKey: "pub_test_example",
          phoneNumber,
          fetchImplementation: () => Promise.resolve(response()),
          onAwaiting: () => undefined,
        })
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(String(result)).not.toContain("CANARY");
      expect(() => Redacted.value(phoneNumber)).toThrow();
    })
  )
);

it("binds Production authorization to its fixed origin and token environment", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const provider = vi.fn((url: RequestInfo | URL) => {
        expect(url).toBe("https://production.wompi.co/v1/tokens/nequi");
        return Promise.resolve(tokenResponse("APPROVED", "nequi_prod_example"));
      });
      const token = yield* authorizeNequiWithWompi({
        publicKey: "pub_prod_example",
        phoneNumber: Redacted.make("3991111111"),
        fetchImplementation: provider,
        onAwaiting: () => undefined,
      });
      expect(Redacted.value(token)).toBe("nequi_prod_example");
      expect(provider.mock.calls).toHaveLength(1);
      // This test uses only an injected transport; it never contacts Production.
    })
  ));

for (const outcome of [
  { status: "APPROVED", id: "nequi_test_example", approved: true },
  { status: "DECLINED", id: "nequi_test_example", approved: false },
  { status: "ERROR", id: "nequi_test_example", approved: false },
  { status: "APPROVED", id: "nequi_test_changed", approved: false },
] as const) {
  effectIt.effect(
    `polls the original authorization and handles ${outcome.status}/${outcome.id}`,
    () =>
      Effect.gen(function* () {
        const awaiting = Promise.withResolvers<void>();
        const provider = vi
          .fn()
          .mockResolvedValueOnce(tokenResponse("PENDING"))
          .mockResolvedValueOnce(tokenResponse(outcome.status, outcome.id));
        const fiber = yield* Effect.forkChild(
          authorizeNequiWithWompi({
            publicKey: "pub_test_example",
            phoneNumber: Redacted.make("3991111111"),
            fetchImplementation: provider,
            onAwaiting: () => awaiting.resolve(),
          }),
          { startImmediately: true }
        );
        yield* Effect.tryPromise(() => awaiting.promise);
        yield* TestClock.adjust("3 seconds");
        const result = yield* Fiber.await(fiber);
        expect(Exit.isSuccess(result)).toBe(outcome.approved);
        expect(provider).toHaveBeenCalledTimes(2);
        expect(provider.mock.calls[1]?.[0]).toBe(
          "https://sandbox.wompi.co/v1/tokens/nequi/nequi_test_example"
        );
        expect(provider.mock.calls[1]?.[1]).toMatchObject({
          method: "GET",
          cache: "no-store",
          credentials: "omit",
          redirect: "error",
        });
      })
  );
}

effectIt.effect("stops a pending authorization at the bounded approval deadline", () =>
  Effect.gen(function* () {
    const awaiting = Promise.withResolvers<void>();
    const provider = vi.fn(() => Promise.resolve(tokenResponse("PENDING")));
    const fiber = yield* Effect.forkChild(
      authorizeNequiWithWompi({
        publicKey: "pub_test_example",
        phoneNumber: Redacted.make("3991111111"),
        fetchImplementation: provider,
        onAwaiting: () => awaiting.resolve(),
      }),
      { startImmediately: true }
    );
    yield* Effect.tryPromise(() => awaiting.promise);
    yield* TestClock.adjust("5 minutes");
    const result = yield* Fiber.await(fiber);
    expect(Exit.isFailure(result)).toBe(true);
    expect(provider.mock.calls.length).toBeLessThanOrEqual(100);
  })
);

effectIt.effect("aborts the in-flight provider request when authorization is interrupted", () =>
  Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    const requested = Promise.withResolvers<Response>();
    let aborted = false;
    const fiber = yield* Effect.forkChild(
      authorizeNequiWithWompi({
        publicKey: "pub_test_example",
        phoneNumber: Redacted.make("3991111111"),
        fetchImplementation: (_url, init) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            requested.reject(new Error("CANARY-provider-failure"));
          });
          started.resolve();
          return requested.promise;
        },
        onAwaiting: () => undefined,
      }),
      { startImmediately: true }
    );
    yield* Effect.tryPromise(() => started.promise);
    yield* Fiber.interrupt(fiber);
    const result = yield* Fiber.await(fiber);
    expect(aborted).toBe(true);
    expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true);
    expect(String(result)).not.toContain("CANARY");
  })
);
