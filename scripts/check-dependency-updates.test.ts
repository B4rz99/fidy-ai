// @vitest-environment node

import { it } from "@effect/vitest";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Option } from "effect";
import { HttpClient, type HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { expect } from "vitest";
import { checkDependencyUpdates } from "./check-dependency-updates";

const clientLayer = (
  handler: (request: Parameters<typeof HttpClientResponse.fromWeb>[0]) => Response
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.makeWith<
      HttpClientError.HttpClientError,
      never,
      HttpClientError.HttpClientError,
      never
    >(
      (effect) =>
        Effect.map(effect, (request) => HttpClientResponse.fromWeb(request, handler(request))),
      Effect.succeed
    )
  );

it.effect.each([undefined, "1"])(
  "refuses actual registry bytes beyond the packument budget despite declared length %s",
  (declaredLength) =>
    Effect.gen(function* () {
      const bytes = new Uint8Array(64 * 1024 * 1024 + 1);
      let calls = 0;
      let cancelled = 0;
      const httpClient = clientLayer(() => {
        calls += 1;
        return new Response(
          new ReadableStream({
            start(controller): void {
              controller.enqueue(bytes);
            },
            cancel(): void {
              cancelled += 1;
            },
          }),
          { headers: declaredLength === undefined ? {} : { "content-length": declaredLength } }
        );
      });
      const services = yield* Layer.build(httpClient);
      const exit = yield* checkDependencyUpdates.pipe(
        Effect.provideService(HttpClient.HttpClient, Context.get(services, HttpClient.HttpClient)),
        Effect.exit
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
          message: "Registry response exceeded its byte budget",
        });
      }
      expect(calls).toBeGreaterThan(0);
      expect(calls).toBeLessThanOrEqual(8);
      expect(cancelled).toBe(calls);
    }).pipe(Effect.scoped)
);

it.effect.each([
  { name: "retryable status", status: 503, headers: new Headers() },
  {
    name: "declared oversized body",
    status: 200,
    headers: new Headers({ "content-length": String(64 * 1024 * 1024 + 1) }),
  },
])("aborts rejected $name responses before another request or return", ({ status, headers }) =>
  Effect.gen(function* () {
    const previous = new Map<string, AbortSignal>();
    const signals: AbortSignal[] = [];
    const client = HttpClient.make((request, _url, signal) =>
      Effect.sync(() => {
        const last = previous.get(request.url);
        if (last !== undefined && !last.aborted) {
          throw new Error("Previous attempt was not released");
        }
        previous.set(request.url, signal);
        signals.push(signal);
        return HttpClientResponse.fromWeb(
          request,
          new Response(new ReadableStream<Uint8Array>(), { status, headers })
        );
      })
    );
    const exit = yield* checkDependencyUpdates.pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.exit
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.hasDies(exit.cause)).toBe(false);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  }).pipe(Effect.scoped)
);

it.effect(
  "bounds every retry including registry body consumption and cancels pending streams",
  () =>
    Effect.gen(function* () {
      const ready = yield* Deferred.make<void>();
      let calls = 0;
      let cancelled = 0;
      const httpClient = clientLayer(() => {
        calls += 1;
        return new Response(
          new ReadableStream({
            pull(): void {
              Deferred.doneUnsafe(ready, Effect.void);
            },
            cancel(): void {
              cancelled += 1;
            },
          })
        );
      });
      const services = yield* Layer.build(httpClient);
      const fiber = yield* checkDependencyUpdates.pipe(
        Effect.provideService(HttpClient.HttpClient, Context.get(services, HttpClient.HttpClient)),
        Effect.exit,
        Effect.forkScoped
      );
      yield* Deferred.await(ready);
      for (let attempt = 0; attempt < 4; attempt += 1) yield* TestClock.adjust("30 seconds");
      const exit = yield* Fiber.join(fiber);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(calls).toBeGreaterThanOrEqual(4);
      expect(calls).toBeLessThanOrEqual(32);
      expect(cancelled).toBe(calls);
    }).pipe(Effect.scoped)
);
