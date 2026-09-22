import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import {
  RequestBodyCapacityExceeded,
  RequestBodyDeadlineExceeded,
  RequestBodyPolicy,
  readBoundedRequestBody,
} from "./request-body";

const requestWithBody = (body: ReadableStream<Uint8Array>): Request =>
  new Request("https://api.fidyapp.com/canonical", { body, method: "POST" });

const neverSettlingCancellation = Effect.runPromise(Effect.never);
const decodeRequestBodyPolicy = Schema.decodeSync(RequestBodyPolicy);
const requestBodyPolicy = decodeRequestBodyPolicy({
  deadlineMilliseconds: 1_000,
  maximumBytes: 4,
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
