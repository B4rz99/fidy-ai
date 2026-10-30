import { telemetryTraceHeader } from "@fidy/server/browser-transport";
// @vitest-environment node

import { describe, expect, it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { afterEach, beforeEach, vi } from "vitest";
import { browserHttpClientLayer } from "./browser-http-policy";

const origin = "https://api.test.fidyapp.com";
const traceId = "0123456789abcdef0123456789abcdef";
const makeClient = (raw: HttpClient.HttpClient): Effect.Effect<HttpClient.HttpClient> =>
  Layer.build(
    Layer.succeed(HttpClient.HttpClient, raw).pipe(browserHttpClientLayer("web-auth", origin))
  ).pipe(
    Effect.map((context) => Context.get(context, HttpClient.HttpClient)),
    Effect.scoped
  );

const diagnosticConsole = console;

describe("browser transport diagnostics", () => {
  beforeEach(() => {
    vi.spyOn(diagnosticConsole, "info").mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it.effect("projects one bounded record and preserves the server trace through body refusal", () =>
    Effect.gen(function* () {
      const sentinel = "private-financial-credential-sentinel";
      const client = yield* makeClient(
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response("x".repeat(65_537), {
                headers: { [telemetryTraceHeader]: traceId, "x-private": sentinel },
              })
            )
          )
        )
      );
      const result = yield* Effect.exit(
        client.post(`${origin}/private/${sentinel}?proof=${sentinel}`)
      );
      expect(Exit.isFailure(result)).toBe(true);
      expect(diagnosticConsole.info).toHaveBeenCalledExactlyOnceWith("fidy.browser.transport", {
        component: "browser",
        operation: "browser.transport",
        boundary: "web-auth",
        outcome: "failed",
        attempts: 1,
        durationMilliseconds: 0,
        traceId,
        statusClass: "2xx",
        error: "DecodeError",
      });
      const calls = vi.mocked(diagnosticConsole.info).mock.calls;
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(calls)
      ).not.toContain(sentinel);
      if (Exit.isFailure(result)) {
        expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result)).toContain(
          traceId
        );
        expect(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(result)
        ).not.toContain(sentinel);
      }
    })
  );

  it.effect("rejects untrusted trace receipts and emits no raw transport failures", () =>
    Effect.gen(function* () {
      const sentinel = "private-provider-body";
      const refused = yield* makeClient(
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(sentinel, {
                status: 503,
                headers: { [telemetryTraceHeader]: sentinel, authorization: sentinel },
              })
            )
          )
        )
      );
      yield* refused.post(`${origin}/work`);
      expect(diagnosticConsole.info).toHaveBeenLastCalledWith("fidy.browser.transport", {
        component: "browser",
        operation: "browser.transport",
        boundary: "web-auth",
        outcome: "failed",
        attempts: 1,
        durationMilliseconds: 0,
        statusClass: "5xx",
      });
      const failed = yield* makeClient(
        HttpClient.make((request) =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({
                request,
                cause: new Error(sentinel),
                description: sentinel,
              }),
            })
          )
        )
      );
      yield* Effect.exit(failed.post(`${origin}/work`));
      expect(diagnosticConsole.info).toHaveBeenLastCalledWith("fidy.browser.transport", {
        component: "browser",
        operation: "browser.transport",
        boundary: "web-auth",
        outcome: "failed",
        attempts: 1,
        durationMilliseconds: 0,
        error: "TransportError",
      });
      expect(
        yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
          vi.mocked(diagnosticConsole.info).mock.calls
        )
      ).not.toContain(sentinel);
    })
  );

  it.effect("reports cancellation once and preserves underlying request cleanup", () =>
    Effect.gen(function* () {
      const started = Deferred.makeUnsafe<void>();
      let cancelled = false;
      const cancel = (): void => {
        cancelled = true;
      };
      const raw = HttpClient.make(() =>
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(cancel))
        )
      );
      const client = yield* makeClient(raw);
      const fiber = yield* Effect.forkChild(client.post(`${origin}/work`));
      yield* Deferred.await(started);
      yield* Fiber.interrupt(fiber);
      expect(cancelled).toBe(true);
      expect(diagnosticConsole.info).toHaveBeenCalledExactlyOnceWith("fidy.browser.transport", {
        component: "browser",
        operation: "browser.transport",
        boundary: "web-auth",
        outcome: "interrupted",
        attempts: 1,
        durationMilliseconds: 0,
      });
    })
  );

  it.effect("distinguishes deadline exhaustion and never changes work when export throws", () =>
    Effect.gen(function* () {
      const client = yield* makeClient(HttpClient.make(() => Effect.never));
      const fiber = yield* Effect.forkChild(client.post(`${origin}/work`));
      yield* TestClock.adjust("10 seconds");
      expect(Exit.isFailure(yield* Fiber.await(fiber))).toBe(true);
      expect(diagnosticConsole.info).toHaveBeenCalledExactlyOnceWith("fidy.browser.transport", {
        component: "browser",
        operation: "browser.transport",
        boundary: "web-auth",
        outcome: "failed",
        attempts: 1,
        durationMilliseconds: 10_000,
        error: "timeout",
      });
      vi.mocked(diagnosticConsole.info).mockImplementation(() => {
        throw new Error("sink unavailable");
      });
      const available = yield* makeClient(
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}")))
        )
      );
      expect((yield* available.post(`${origin}/work`)).status).toBe(200);
    })
  );

  it.effect(
    "aggregates safe read retries into one diagnostic and refuses foreign destinations",
    () =>
      Effect.gen(function* () {
        let sent = 0;
        const client = yield* makeClient(
          HttpClient.make((request) => {
            sent++;
            return sent === 1
              ? Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({ request }),
                  })
                )
              : Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}")));
          })
        );
        yield* client.get(`${origin}/work`);
        expect(diagnosticConsole.info).toHaveBeenCalledExactlyOnceWith("fidy.browser.transport", {
          component: "browser",
          operation: "browser.transport",
          boundary: "web-auth",
          outcome: "succeeded",
          attempts: 2,
          durationMilliseconds: 0,
          statusClass: "2xx",
        });
        yield* Effect.exit(client.post("https://attacker.example/private"));
        expect(sent).toBe(2);
        expect(diagnosticConsole.info).toHaveBeenLastCalledWith("fidy.browser.transport", {
          component: "browser",
          operation: "browser.transport",
          boundary: "web-auth",
          outcome: "failed",
          attempts: 0,
          durationMilliseconds: 0,
          error: "TransportError",
        });
      })
  );
});
