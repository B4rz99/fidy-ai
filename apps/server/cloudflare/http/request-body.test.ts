import { deepStrictEqual } from "node:assert";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import {
  RequestBodyCapacityExceeded,
  RequestBodyDeadlineExceeded,
  RequestBodyPolicy,
} from "./contract";
import {
  awaitRequestAbort,
  boundedJsonBody,
  collectBoundedRequestBody,
  readBoundedRequestBody,
} from "./operations";

const requestWithBody = (body: ReadableStream<Uint8Array>): Request =>
  new Request("https://api.fidyapp.com/canonical", { body, method: "POST" });

it.each(["held", "throws", "rejects"])(
  "initiates held body cleanup (%s) on native Request cancellation without returning partial bytes",
  (cleanup) => {
    const requestAbort = new AbortController();
    const ownerAbort = new AbortController();
    const ready = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const cancelSettled = Promise.withResolvers<void>();
    let cancelStarted = false;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller): Promise<void> {
          ready.resolve();
          return released.promise.then(() => {
            if (!cancelStarted) controller.close();
          });
        },
        cancel(): Promise<void> {
          cancelStarted = true;
          cancelled.resolve();
          if (cleanup === "throws") throw new Error("private cleanup detail");
          if (cleanup === "rejects") return Promise.reject(new Error("private cleanup detail"));
          return cancelSettled.promise;
        },
      },
      { highWaterMark: 0 }
    );
    const request = new Request("https://api.fidyapp.com/canonical", {
      method: "POST",
      body: stream,
      signal: requestAbort.signal,
    });
    return Effect.runPromise(
      Effect.gen(function* () {
        const run = Effect.runPromiseExitWith(yield* Effect.context<never>());
        let decision = false;
        const pending = run(
          readBoundedRequestBody(request, requestBodyPolicy).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                decision = true;
              })
            )
          ),
          { signal: ownerAbort.signal }
        );
        yield* Effect.tryPromise(() => ready.promise);
        requestAbort.abort();
        yield* Effect.tryPromise(() => cancelled.promise).pipe(Effect.timeout("250 millis"));
        const exit = yield* Effect.tryPromise(() => pending);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          // Retain fn stack annotations in the expected whole Exit, not just its interruption tag.
          deepStrictEqual(
            exit,
            Exit.failCause(Cause.annotate(Cause.interrupt(), Cause.annotations(exit.cause)))
          );
        }
        expect(request.body?.locked).toBe(false);
        expect(decision).toBe(false);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            ownerAbort.abort();
            released.resolve();
            cancelSettled.resolve();
          })
        )
      )
    );
  }
);

it.effect(
  "keeps JSON body deadlines on the inherited Clock and starts held cleanup before deciding",
  () => {
    const ready = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    const cancelSettled = Promise.withResolvers<void>();
    let cancelled = false;
    const request = new Request("https://api.fidyapp.com/canonical", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new ReadableStream<Uint8Array>(
        {
          pull(controller): Promise<void> {
            ready.resolve();
            return released.promise.then(() => {
              if (!cancelled) {
                controller.enqueue(new Uint8Array([49]));
                controller.close();
              }
            });
          },
          cancel(): Promise<void> {
            cancelled = true;
            return cancelSettled.promise;
          },
        },
        { highWaterMark: 0 }
      ),
    });
    return Effect.gen(function* () {
      const fiber = yield* boundedJsonBody({
        request,
        policy: requestBodyPolicy,
        schema: Schema.Finite,
      }).pipe(Effect.exit, Effect.forkScoped);
      yield* Effect.tryPromise(() => ready.promise);
      yield* TestClock.adjust("1 second");
      deepStrictEqual(yield* Fiber.join(fiber), Exit.succeed(Option.none()));
      expect(cancelled).toBe(true);
      expect(request.body?.locked).toBe(false);
    }).pipe(
      Effect.scoped,
      Effect.ensuring(
        Effect.sync(() => {
          released.resolve();
          cancelSettled.resolve();
        })
      )
    );
  }
);

it.effect.each([
  { name: "valid", bytes: [49], expected: Option.some(1) },
  { name: "invalid UTF-8", bytes: [255], expected: Option.none() },
  { name: "invalid JSON", bytes: [123], expected: Option.none() },
  { name: "invalid schema", bytes: [116, 114, 117, 101], expected: Option.none() },
  { name: "overflow", bytes: [49, 50, 51, 52, 53], expected: Option.none() },
])("preserves private JSON refusal for $name", ({ bytes, expected }) =>
  Effect.gen(function* () {
    const request = new Request("https://api.fidyapp.com/canonical", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: new Uint8Array(bytes),
    });
    const exit = yield* boundedJsonBody({
      request,
      policy: requestBodyPolicy,
      schema: Schema.Finite,
    }).pipe(Effect.exit);
    deepStrictEqual(exit, Exit.succeed(expected));
    expect(request.body?.locked).toBe(false);
  })
);

const neverSettlingCancellation = Effect.runPromise(Effect.never);
const decodeRequestBodyPolicy = Schema.decodeSync(RequestBodyPolicy);
const requestBodyPolicy = decodeRequestBodyPolicy({
  deadlineMilliseconds: 1_000,
  maximumBytes: 4,
});

it.effect("observes a request aborted before cancellation-listener registration", () => {
  const controller = new AbortController();
  return Effect.gen(function* () {
    const request = new Request("https://documents.internal/extract", {
      signal: controller.signal,
    });
    controller.abort();
    const failure = yield* awaitRequestAbort(request).pipe(Effect.flip);
    expect(failure.reason).toBe("cancelled");
  });
});

it.effect("bounds document collection without awaiting untrusted cancellation on overflow", () =>
  Effect.gen(function* () {
    let cancelled = false;
    const request = requestWithBody(
      new ReadableStream({
        start(controller): void {
          controller.enqueue(new Uint8Array([1, 2, 3, 4, 5]));
        },
        cancel(): Promise<void> {
          cancelled = true;
          return neverSettlingCancellation;
        },
      })
    );
    const failure = yield* collectBoundedRequestBody(request, 4).pipe(Effect.flip);
    expect(failure.reason).toBe("resource-limit");
    expect(cancelled).toBe(true);
    expect(request.body?.locked).toBe(false);
  })
);

it.effect("cancels document collection and unlocks its reader when a request aborts", () => {
  const controller = new AbortController();
  return Effect.gen(function* () {
    let cancelled = false;
    const request = new Request("https://documents.internal/extract", {
      method: "POST",
      signal: controller.signal,
      body: new ReadableStream({
        cancel(): Promise<void> {
          cancelled = true;
          return neverSettlingCancellation;
        },
      }),
    });
    const fiber = yield* collectBoundedRequestBody(request, 4).pipe(Effect.flip, Effect.forkScoped);
    yield* Effect.yieldNow;
    controller.abort();
    const failure = yield* Fiber.join(fiber);
    expect(failure.reason).toBe("cancelled");
    expect(cancelled).toBe(true);
    expect(request.body?.locked).toBe(false);
  }).pipe(Effect.scoped);
});

it("rejects request-body policies without positive finite limits", () => {
  expect(() =>
    decodeRequestBodyPolicy({ deadlineMilliseconds: 0, maximumBytes: Number.POSITIVE_INFINITY })
  ).toThrow();
});

it.effect("accepts a request body exactly at its byte limit", () =>
  Effect.gen(function* () {
    const request = requestWithBody(
      new ReadableStream({
        start(controller): void {
          controller.enqueue(new Uint8Array([1, 2]));
          controller.enqueue(new Uint8Array([3, 4]));
          controller.close();
        },
      })
    );

    const bytes = yield* readBoundedRequestBody(request, requestBodyPolicy);

    expect(bytes).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(request.body?.locked).toBe(false);
  })
);

it.effect("cancels request-body consumption at the first overflowing chunk", () =>
  Effect.gen(function* () {
    let cancelled = false;
    let pulls = 0;
    const chunks = [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5]), new Uint8Array([6])];
    const request = requestWithBody(
      new ReadableStream({
        cancel(): void {
          cancelled = true;
        },
        pull(controller): void {
          const chunk = chunks.at(pulls);
          pulls += 1;
          if (chunk === undefined) controller.close();
          else controller.enqueue(chunk);
        },
      })
    );

    const failure = yield* readBoundedRequestBody(request, requestBodyPolicy).pipe(Effect.flip);

    expect(failure).toBeInstanceOf(RequestBodyCapacityExceeded);
    expect(cancelled).toBe(true);
    expect(pulls).toBe(2);
    expect(request.body?.locked).toBe(false);
  })
);

it.effect("deadlines and cancels a request body that never yields a chunk", () =>
  Effect.gen(function* () {
    let cancelled = false;
    const request = requestWithBody(
      new ReadableStream({
        cancel(): Promise<void> {
          cancelled = true;
          return neverSettlingCancellation;
        },
      })
    );
    let businessEffectRan = false;
    const fiber = yield* readBoundedRequestBody(request, requestBodyPolicy).pipe(
      Effect.tap(() => Effect.sync(() => (businessEffectRan = true))),
      Effect.exit,
      Effect.forkChild({ startImmediately: true })
    );
    yield* Effect.yieldNow;

    yield* TestClock.adjust("1 second");
    const exit = yield* Fiber.join(fiber);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBeInstanceOf(
        RequestBodyDeadlineExceeded
      );
    }
    expect(cancelled).toBe(true);
    expect(request.body?.locked).toBe(false);
    expect(businessEffectRan).toBe(false);
  })
);

it.effect("deadlines and cancels a request body that stalls between chunks", () =>
  Effect.gen(function* () {
    let cancelled = false;
    const request = requestWithBody(
      new ReadableStream({
        cancel(): void {
          cancelled = true;
        },
        start(controller): void {
          controller.enqueue(new Uint8Array([1, 2]));
        },
      })
    );
    const fiber = yield* readBoundedRequestBody(request, requestBodyPolicy).pipe(
      Effect.exit,
      Effect.forkChild({ startImmediately: true })
    );
    yield* Effect.yieldNow;

    yield* TestClock.adjust("1 second");
    const exit = yield* Fiber.join(fiber);

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBeInstanceOf(
        RequestBodyDeadlineExceeded
      );
    }
    expect(cancelled).toBe(true);
    expect(request.body?.locked).toBe(false);
  })
);
