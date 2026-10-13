// @vitest-environment node
import { Context, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { HttpClient, type HttpClientError, HttpClientResponse } from "effect/http";
import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { bindBrowserSession } from "./session-binding";
import { browserHttpClientLayer } from "./browser-http-policy";

it.effect("retires a streamed response and refuses further requests from the old session", () => {
  const lifetime = new AbortController();
  return Effect.gen(function* () {
    const headersReceived = yield* Deferred.make<void>();
    const canceled = vi.fn();
    const requests = vi.fn();
    const transport = HttpClient.makeWith<
      HttpClientError.HttpClientError,
      never,
      HttpClientError.HttpClientError,
      never
    >(
      Effect.flatMap((request) =>
        Effect.gen(function* () {
          requests();
          expect(request.headers["fidy-session-binding"]).toBe("session-a");
          const response = HttpClientResponse.fromWeb(
            request,
            new Response(new ReadableStream<Uint8Array>({ cancel: canceled }))
          );
          yield* Deferred.succeed(headersReceived, undefined);
          return response;
        })
      ),
      Effect.succeed
    );
    const services = yield* Layer.build(
      bindBrowserSession({
        transport: Layer.succeed(HttpClient.HttpClient, transport).pipe(
          browserHttpClientLayer("canonical", "https://api.test.fidyapp.com")
        ),
        lifetime: { binding: "session-a", signal: lifetime.signal, expired: vi.fn() },
      })
    );
    const client = Context.get(services, HttpClient.HttpClient);
    const pending = yield* Effect.forkChild(
      client.get("https://api.test.fidyapp.com/transactions")
    );
    yield* Deferred.await(headersReceived);
    yield* Effect.yieldNow;
    lifetime.abort();
    expect(Exit.isFailure(yield* Fiber.await(pending))).toBe(true);
    expect(canceled).toHaveBeenCalledOnce();
    expect(
      Exit.isFailure(yield* Effect.exit(client.get("https://api.test.fidyapp.com/transactions")))
    ).toBe(true);
    expect(requests).toHaveBeenCalledOnce();
  }).pipe(Effect.scoped);
});
