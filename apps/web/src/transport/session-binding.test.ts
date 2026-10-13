// @vitest-environment node
import { Context, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import { HttpClient, type HttpClientError, HttpClientResponse } from "effect/http";
import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import { bindBrowserSession, loadBrowserSessionBinding } from "./session-binding";
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

for (const scenario of [
  { binding: "session-a", status: 200, expirations: 0 },
  { binding: "session-a", status: 401, expirations: 1 },
  { binding: "none", status: 401, expirations: 0 },
]) {
  it.effect(
    `handles ${scenario.status} for ${scenario.binding} without changing request identity`,
    () => {
      const lifetime = new AbortController();
      const expired = vi.fn();
      return Effect.gen(function* () {
        const transport = HttpClient.makeWith<
          HttpClientError.HttpClientError,
          never,
          HttpClientError.HttpClientError,
          never
        >(
          Effect.map((request) => {
            expect(request.headers["fidy-session-binding"]).toBe(scenario.binding);
            return HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: scenario.status })
            );
          }),
          Effect.succeed
        );
        const services = yield* Layer.build(
          bindBrowserSession({
            transport: Layer.succeed(HttpClient.HttpClient, transport),
            lifetime: { binding: scenario.binding, signal: lifetime.signal, expired },
          })
        );
        const reply = yield* Context.get(services, HttpClient.HttpClient).get(
          "https://api.test.fidyapp.com/user",
          { headers: { "Fidy-Session-Binding": "untrusted-override" } }
        );
        expect(reply.status).toBe(scenario.status);
        expect(expired).toHaveBeenCalledTimes(scenario.expirations);
      }).pipe(Effect.scoped);
    }
  );
}

it.effect("bootstraps a session identity and signed-out identity through credentialed HTTP", () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ binding: "20000000-0000-4000-8000-000000000003" }))
    .mockResolvedValueOnce(Response.json({ binding: null }));
  const lifetime = new AbortController();
  return Effect.gen(function* () {
    expect(
      yield* Effect.tryPromise(() =>
        loadBrowserSessionBinding({
          apiOrigin: "https://api.test.fidyapp.com",
          signal: lifetime.signal,
        })
      )
    ).toBe("20000000-0000-4000-8000-000000000003");
    expect(
      yield* Effect.tryPromise(() =>
        loadBrowserSessionBinding({
          apiOrigin: "https://api.test.fidyapp.com",
          signal: lifetime.signal,
        })
      )
    ).toBe("none");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://api.test.fidyapp.com/web/session/binding"),
      expect.objectContaining({ credentials: "include" })
    );
  }).pipe(Effect.ensuring(Effect.sync(() => fetch.mockRestore())));
});

it.effect("rejects a response completed synchronously as its session is retired", () => {
  const lifetime = new AbortController();
  const expired = vi.fn();
  return Effect.gen(function* () {
    const transport = HttpClient.makeWith<
      HttpClientError.HttpClientError,
      never,
      HttpClientError.HttpClientError,
      never
    >(
      Effect.map((request) => {
        lifetime.abort();
        return HttpClientResponse.fromWeb(request, new Response(null));
      }),
      Effect.succeed
    );
    const services = yield* Layer.build(
      bindBrowserSession({
        transport: Layer.succeed(HttpClient.HttpClient, transport),
        lifetime: { binding: "session-a", signal: lifetime.signal, expired },
      })
    );
    expect(
      Exit.isFailure(
        yield* Effect.exit(
          Context.get(services, HttpClient.HttpClient).get("https://api.test.fidyapp.com/user")
        )
      )
    ).toBe(true);
    expect(expired).not.toHaveBeenCalled();
  }).pipe(Effect.scoped);
});
