import { it as effectIt } from "@effect/vitest";
import { Cause, Clock, Effect, Exit, Fiber, Option, Redacted } from "effect";
import { TestClock } from "effect/testing";
import { expect, it, vi } from "vitest";
import { NequiAuthorizationFailed, withApprovedNequiWithWompi } from "./wompi-nequi";

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
      const phoneNumber = Redacted.make(input.phoneNumber);
      const clearPhone = vi.fn();
      const result = yield* Effect.exit(
        withApprovedNequiWithWompi(
          {
            ...input,
            phoneNumber,
            fetchImplementation: provider,
            clearPhone,
            onAwaiting: () => undefined,
          },
          (token) => Effect.succeed(Redacted.value(token))
        )
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(provider).not.toHaveBeenCalled();
      expect(clearPhone).toHaveBeenCalledTimes(1);
      expect(() => Redacted.value(phoneNumber)).toThrow();
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
])("fails closed without reflecting $name", ({ name, response }) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const phoneNumber = Redacted.make("3991111111");
      const awaiting = vi.fn();
      const result = yield* Effect.exit(
        withApprovedNequiWithWompi(
          {
            publicKey: "pub_test_example",
            phoneNumber,
            fetchImplementation: () => Promise.resolve(response()),
            clearPhone: () => undefined,
            onAwaiting: awaiting,
          },
          (token) => Effect.succeed(Redacted.value(token))
        )
      );
      expect(result).toEqual(
        Exit.fail(
          new NequiAuthorizationFailed({
            reason: name === "declined" ? "declined" : "unavailable",
          })
        )
      );
      expect(awaiting).not.toHaveBeenCalled();
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
      const token = yield* withApprovedNequiWithWompi(
        {
          publicKey: "pub_prod_example",
          phoneNumber: Redacted.make("3991111111"),
          fetchImplementation: provider,
          clearPhone: () => undefined,
          onAwaiting: () => undefined,
        },
        (token) => Effect.succeed(Redacted.value(token))
      );
      expect(token).toBe("nequi_prod_example");
      expect(provider.mock.calls).toHaveLength(1);
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
          withApprovedNequiWithWompi(
            {
              publicKey: "pub_test_example",
              phoneNumber: Redacted.make("3991111111"),
              fetchImplementation: provider,
              clearPhone: () => undefined,
              onAwaiting: () => awaiting.resolve(),
            },
            (token) => Effect.succeed(Redacted.value(token))
          ),
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
      withApprovedNequiWithWompi(
        {
          publicKey: "pub_test_example",
          phoneNumber: Redacted.make("3991111111"),
          fetchImplementation: provider,
          clearPhone: () => undefined,
          onAwaiting: () => awaiting.resolve(),
        },
        (token) => Effect.succeed(Redacted.value(token))
      ),
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
      withApprovedNequiWithWompi(
        {
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
          clearPhone: () => undefined,
          onAwaiting: () => undefined,
        },
        (token) => Effect.succeed(Redacted.value(token))
      ),
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

it("borrows approval once, wipes its token on consumer failure and never shows awaiting", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const awaiting = vi.fn();
      const clearPhone = vi.fn();
      const borrowed: Array<Redacted.Redacted<string>> = [];
      const consumerFailure = new Error("synthetic submission failure");
      const result = yield* Effect.exit(
        withApprovedNequiWithWompi(
          {
            publicKey: "pub_test_example",
            phoneNumber: Redacted.make("3991111111"),
            fetchImplementation: () => Promise.resolve(tokenResponse("APPROVED")),
            clearPhone,
            onAwaiting: awaiting,
          },
          (token) => {
            borrowed.push(token);
            expect(Redacted.value(token)).toBe("nequi_test_example");
            return Effect.fail(consumerFailure);
          }
        )
      );
      expect(result).toEqual(Exit.fail(consumerFailure));
      expect(borrowed).toHaveLength(1);
      for (const token of borrowed) expect(() => Redacted.value(token)).toThrow();
      expect(clearPhone).toHaveBeenCalledTimes(1);
      expect(awaiting).not.toHaveBeenCalled();
    })
  ));

for (const status of ["APPROVED", "PENDING"] as const) {
  effectIt.effect(`evaluates the final allowed ${status} response before exhaustion`, () =>
    Effect.gen(function* () {
      const penultimate = Promise.withResolvers<Response>();
      let requests = 0;
      const consumer = vi.fn(() => Effect.succeed("submitted once"));
      const fiber = yield* Effect.forkChild(
        withApprovedNequiWithWompi(
          {
            publicKey: "pub_test_example",
            phoneNumber: Redacted.make("3991111111"),
            clearPhone: () => undefined,
            onAwaiting: () => undefined,
            fetchImplementation: () => {
              requests++;
              if (requests === 100) return penultimate.promise;
              return Promise.resolve(tokenResponse(requests === 101 ? status : "PENDING"));
            },
          },
          consumer
        ),
        { startImmediately: true }
      );
      yield* TestClock.adjust("297 seconds");
      expect(requests).toBe(100);
      // A wall-clock correction makes the last spaced GET reachable before the original deadline.
      yield* TestClock.setTime(294_000);
      penultimate.resolve(tokenResponse("PENDING"));
      yield* TestClock.adjust("3 seconds");
      const result = yield* Fiber.await(fiber);
      expect(requests).toBe(101);
      expect(result).toEqual(
        status === "APPROVED"
          ? Exit.succeed("submitted once")
          : Exit.fail(new NequiAuthorizationFailed({ reason: "unavailable" }))
      );
      expect(consumer).toHaveBeenCalledTimes(status === "APPROVED" ? 1 : 0);
    })
  );
}

effectIt.effect(
  "includes POST time in the original deadline and aborts an unresolved final lookup",
  () =>
    Effect.gen(function* () {
      const post = Promise.withResolvers<Response>();
      const started = Promise.withResolvers<void>();
      const consumer = vi.fn(() => Effect.void);
      const phoneNumber = Redacted.make("3991111111");
      const clearPhone = vi.fn();
      let requests = 0;
      let lastSignal: Option.Option<AbortSignal> = Option.none();
      const fiber = yield* Effect.forkChild(
        withApprovedNequiWithWompi(
          {
            publicKey: "pub_test_example",
            phoneNumber,
            clearPhone,
            onAwaiting: () => undefined,
            fetchImplementation: (_url, init) => {
              requests++;
              if (requests === 1) {
                started.resolve();
                return post.promise;
              }
              lastSignal = Option.fromNullishOr(init?.signal);
              return requests === 97
                ? Promise.withResolvers<Response>().promise
                : Promise.resolve(tokenResponse("PENDING"));
            },
          },
          consumer
        ),
        { startImmediately: true }
      );
      yield* Effect.tryPromise(() => started.promise);
      yield* TestClock.adjust("10 seconds");
      post.resolve(tokenResponse("PENDING"));
      yield* TestClock.adjust("290 seconds");
      expect(yield* Fiber.await(fiber)).toEqual(
        Exit.fail(new NequiAuthorizationFailed({ reason: "expired" }))
      );
      expect(requests).toBe(97);
      expect(Option.map(lastSignal, (signal) => signal.aborted)).toEqual(Option.some(true));
      expect(clearPhone).toHaveBeenCalledTimes(1);
      expect(() => Redacted.value(phoneNumber)).toThrow();
      expect(consumer).not.toHaveBeenCalled();
    })
);

effectIt.effect(
  "bounds an unresolved provider POST to fifteen seconds without admitting a consumer",
  () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<void>();
      const consumer = vi.fn(() => Effect.void);
      const clearPhone = vi.fn();
      let signal: Option.Option<AbortSignal> = Option.none();
      const fiber = yield* Effect.forkChild(
        withApprovedNequiWithWompi(
          {
            publicKey: "pub_test_example",
            phoneNumber: Redacted.make("3991111111"),
            clearPhone,
            onAwaiting: () => undefined,
            fetchImplementation: (_url, init) => {
              signal = Option.fromNullishOr(init?.signal);
              started.resolve();
              return Promise.withResolvers<Response>().promise;
            },
          },
          consumer
        ),
        { startImmediately: true }
      );
      yield* Effect.tryPromise(() => started.promise);
      yield* TestClock.adjust("15 seconds");
      expect(yield* Fiber.await(fiber)).toEqual(
        Exit.fail(new NequiAuthorizationFailed({ reason: "unavailable" }))
      );
      expect(Option.map(signal, (signal) => signal.aborted)).toEqual(Option.some(true));
      expect(consumer).not.toHaveBeenCalled();
      expect(clearPhone).toHaveBeenCalledTimes(1);
    })
);

effectIt.effect(
  "keeps consumer work outside authorization expiry and wipes its token on interruption",
  () =>
    Effect.gen(function* () {
      const admitted = Promise.withResolvers<void>();
      const borrowed: Array<Redacted.Redacted<string>> = [];
      const fiber = yield* Effect.forkChild(
        withApprovedNequiWithWompi(
          {
            publicKey: "pub_test_example",
            phoneNumber: Redacted.make("3991111111"),
            clearPhone: () => undefined,
            onAwaiting: () => undefined,
            fetchImplementation: () => Promise.resolve(tokenResponse("APPROVED")),
          },
          (token) => {
            borrowed.push(token);
            admitted.resolve();
            return Effect.never;
          }
        ),
        { startImmediately: true }
      );
      yield* Effect.tryPromise(() => admitted.promise);
      yield* TestClock.adjust("6 minutes");
      for (const token of borrowed) expect(Redacted.value(token)).toBe("nequi_test_example");
      yield* Fiber.interrupt(fiber);
      const result = yield* Fiber.await(fiber);
      expect(Exit.isFailure(result) && Cause.hasInterrupts(result.cause)).toBe(true);
      for (const token of borrowed) expect(() => Redacted.value(token)).toThrow();
    })
);

effectIt.effect(
  "cancels a blocked response reader and suppresses late approval after disposal",
  () =>
    Effect.gen(function* () {
      const reading = Promise.withResolvers<void>();
      const consumer = vi.fn(() => Effect.void);
      const clearPhone = vi.fn();
      let cancellations = 0;
      const body = new ReadableStream<Uint8Array>({
        pull: (): void => {
          reading.resolve();
        },
        cancel: (): void => {
          cancellations++;
        },
      });
      const phoneNumber = Redacted.make("3991111111");
      const fiber = yield* Effect.forkChild(
        withApprovedNequiWithWompi(
          {
            publicKey: "pub_test_example",
            phoneNumber,
            clearPhone,
            onAwaiting: () => undefined,
            fetchImplementation: () => Promise.resolve(new Response(body)),
          },
          consumer
        ),
        { startImmediately: true }
      );
      yield* Effect.tryPromise(() => reading.promise);
      yield* Fiber.interrupt(fiber);
      expect(cancellations).toBe(1);
      expect(body.locked).toBe(false);
      expect(consumer).not.toHaveBeenCalled();
      expect(clearPhone).toHaveBeenCalledTimes(1);
      expect(() => Redacted.value(phoneNumber)).toThrow();
    })
);

effectIt.effect("contains throwing progress callbacks while consuming only matching approval", () =>
  Effect.gen(function* () {
    const awaiting = Promise.withResolvers<void>();
    const provider = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse("PENDING"))
      .mockResolvedValueOnce(tokenResponse("APPROVED"));
    const consumer = vi.fn(() => Effect.succeed("submission remains separate"));
    const fiber = yield* Effect.forkChild(
      withApprovedNequiWithWompi(
        {
          publicKey: "pub_test_example",
          phoneNumber: Redacted.make("3991111111"),
          clearPhone: () => {
            throw new Error("synthetic clear failure");
          },
          onAwaiting: () => {
            awaiting.resolve();
            throw new Error("synthetic progress failure");
          },
          fetchImplementation: provider,
        },
        consumer
      ),
      { startImmediately: true }
    );
    yield* Effect.tryPromise(() => awaiting.promise);
    yield* TestClock.adjust("3 seconds");
    expect(yield* Fiber.await(fiber)).toEqual(Exit.succeed("submission remains separate"));
    expect(provider).toHaveBeenCalledTimes(2);
    expect(consumer).toHaveBeenCalledTimes(1);
  })
);

effectIt.effect(
  "rechecks the absolute deadline after provider parsing before borrowing approval",
  () =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      let now = 0;
      const consumer = vi.fn(() => Effect.void);
      const result = yield* Effect.exit(
        withApprovedNequiWithWompi(
          {
            publicKey: "pub_test_example",
            phoneNumber: Redacted.make("3991111111"),
            clearPhone: () => undefined,
            onAwaiting: () => undefined,
            fetchImplementation: () => {
              now = 300_000;
              return Promise.resolve(tokenResponse("APPROVED"));
            },
          },
          consumer
        ).pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            currentTimeMillis: Effect.sync(() => now),
          })
        )
      );
      expect(result).toEqual(Exit.fail(new NequiAuthorizationFailed({ reason: "expired" })));
      expect(consumer).not.toHaveBeenCalled();
    })
);
