// @vitest-environment node
import { Context, Deferred, Effect, Exit, Fiber, Layer } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  type HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { expect, it } from "@effect/vitest";
import { vi } from "vitest";
import {
  bindBrowserSession,
  coordinateBrowserRequests,
  loadBrowserSessionBinding,
} from "./session-binding";
import { browserHttpClientLayer } from "./browser-http-policy";

for (const aborted of [false, true]) {
  it.effect(
    `shares request capacity across clients and ${aborted ? "cancels queued work on logout" : "releases queued work"}`,
    () => {
      const lifetime = new AbortController();
      return Effect.gen(function* () {
        const held = yield* Deferred.make<void>();
        const occupied = yield* Deferred.make<void>();
        let started = 0;
        const respond = Effect.fn(function* (request: HttpClientRequest.HttpClientRequest) {
          started++;
          if (started === 2) yield* Deferred.succeed(occupied, undefined);
          yield* Deferred.await(held);
          return HttpClientResponse.fromWeb(request, Response.json({}));
        });
        const transport = Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.makeWith<
            HttpClientError.HttpClientError,
            never,
            HttpClientError.HttpClientError,
            never
          >(Effect.flatMap(respond), Effect.succeed)
        );
        const clients = yield* Effect.forEach([0, 1], () =>
          Layer.build(
            bindBrowserSession({
              lifetime: { binding: "same-session", signal: lifetime.signal, expired: vi.fn() },
              transport: coordinateBrowserRequests({ transport, signal: lifetime.signal }).pipe(
                browserHttpClientLayer("canonical", "https://api.test.fidyapp.com")
              ),
            })
          ).pipe(Effect.map((context) => Context.get(context, HttpClient.HttpClient)))
        );
        const first = clients[0];
        const second = clients[1];
        if (first === undefined || second === undefined) throw new Error("Missing test clients");
        const work = yield* Effect.forkChild(
          Effect.all(
            [
              first.get("https://api.test.fidyapp.com/one"),
              second.get("https://api.test.fidyapp.com/two"),
              first.get("https://api.test.fidyapp.com/three"),
            ],
            { concurrency: "unbounded" }
          )
        );
        yield* Deferred.await(occupied);
        yield* Effect.yieldNow;
        expect(started).toBe(2);
        if (aborted) lifetime.abort();
        yield* Deferred.succeed(held, undefined);
        expect(Exit.isSuccess(yield* Fiber.await(work))).toBe(!aborted);
        expect(started).toBe(aborted ? 2 : 3);
      }).pipe(Effect.scoped);
    }
  );
}

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
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(Response.json({ binding: "20000000-0000-4000-8000-000000000003" }))
    .mockResolvedValueOnce(Response.json({ binding: null }));
  return Effect.gen(function* () {
    expect(yield* loadBrowserSessionBinding({ apiOrigin: "https://api.test.fidyapp.com" })).toBe(
      "20000000-0000-4000-8000-000000000003"
    );
    expect(yield* loadBrowserSessionBinding({ apiOrigin: "https://api.test.fidyapp.com" })).toBe(
      "none"
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith(
      new URL("https://api.test.fidyapp.com/web/session/binding"),
      expect.objectContaining({ credentials: "include" })
    );
  }).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
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
