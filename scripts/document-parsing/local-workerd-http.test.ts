import { it } from "@effect/vitest";
import { Data, Effect, Layer, ManagedRuntime, Option, Stream } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { afterEach, expect, vi } from "vitest";
import { ProofHttpLive, requestWorkerd } from "./local-workerd-http";
import { inspectorTarget } from "./workerd-inspector";

const stops: Array<() => Promise<void>> = [];
class ProofFixtureFailure extends Data.TaggedError("ProofFixtureFailure") {}
const drainFirstChunk = Effect.gen(function* () {
  const client = yield* HttpClient.HttpClient;
  const response = yield* HttpClient.withScope(client).get("https://proof.example/statement");
  yield* Stream.runDrain(response.stream.pipe(Stream.take(1)));
}).pipe(Effect.scoped, Effect.timeout("1 second"));

it.live("refuses proof redirects before sending the proof key to another destination", () =>
  Effect.gen(function* () {
    let received = false;
    const destination = serve(() => {
      received = true;
      return new Response("unexpected");
    });
    const port = serve(() => Response.redirect(`http://127.0.0.1:${destination}/target`));
    const response = yield* Effect.tryPromise(() =>
      requestWorkerd({
        method: "POST",
        port,
        path: "/statement",
        body: "synthetic",
        headers: { "x-proof-key": "synthetic-proof" },
        signal: new AbortController().signal,
      })
    );
    expect(response.status).toBe(302);
    expect(received).toBe(false);
  })
);

it.live(
  "owns the request's native proof reader despite a Fetch override and pending cancellation",
  () =>
    Effect.gen(function* () {
      const cancelled = vi.fn(() => Promise.withResolvers<void>().promise);
      const raw = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(new Uint8Array([1]));
        },
        cancel: cancelled,
      });
      const native: typeof fetch = Object.assign(() => Promise.resolve(new Response(raw)), {
        preconnect: fetch.preconnect,
      });
      const stale = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
      const assembled: typeof fetch = Object.assign(stale, { preconnect: fetch.preconnect });
      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          ManagedRuntime.make(
            ProofHttpLive.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, assembled)))
          )
        ),
        (runtime) =>
          Effect.tryPromise({
            try: () =>
              runtime.runPromise(
                drainFirstChunk.pipe(Effect.provideService(FetchHttpClient.Fetch, native))
              ),
            catch: () => new ProofFixtureFailure(),
          }),
        (runtime) =>
          Effect.tryPromise({
            try: () => runtime.dispose(),
            catch: () => new ProofFixtureFailure(),
          }).pipe(Effect.orDie)
      );
      expect(cancelled).toHaveBeenCalledOnce();
      expect(stale).not.toHaveBeenCalled();
      expect(raw.locked).toBe(false);
    })
);

const serve = (handle: (request: Request) => Response | Promise<Response>): number => {
  const server = Bun.serve({ port: 0, fetch: handle });
  stops.push(() => server.stop(true));
  return Number(server.url.port);
};

afterEach(() => Promise.all(stops.splice(0).map((stop) => stop())));

it.live("preserves statement bytes and explicit content type through the local HTTP boundary", () =>
  Effect.gen(function* () {
    const port = serve((request) =>
      request.arrayBuffer().then(
        (body) =>
          new Response(body, {
            headers: { "content-type": request.headers.get("content-type") ?? "" },
          })
      )
    );
    const bytes = new TextEncoder().encode("2026-01-01,1\n");
    const response = yield* Effect.tryPromise(() =>
      requestWorkerd({
        method: "POST",
        port,
        path: "/statement",
        body: bytes,
        headers: { "content-type": "application/pdf" },
        signal: new AbortController().signal,
      })
    );
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(new Uint8Array(yield* Effect.tryPromise(() => response.arrayBuffer()))).toEqual(bytes);
  })
);

it.live("returns a readable DevTools target with the inspector's request lifetime", () =>
  Effect.gen(function* () {
    const port = serve(() => Response.json([{ webSocketDebuggerUrl: "ws://127.0.0.1:1234" }]));
    expect(yield* Effect.tryPromise(() => inspectorTarget({ port, signal: Option.none() }))).toBe(
      "ws://127.0.0.1:1234"
    );
  })
);

it.live("rejects a response that exceeds the streamed proof budget", () =>
  Effect.gen(function* () {
    const huge = new Uint8Array(Number("1048577"));
    const port = serve(() => new Response(huge));
    const failure = yield* Effect.tryPromise(() =>
      requestWorkerd({
        method: "GET",
        port,
        path: "/json",
        signal: new AbortController().signal,
      })
    ).pipe(Effect.flip);
    expect(String(failure.cause)).toContain("WorkerdResponseTooLarge");
  })
);

it.live("aborts an in-flight request after response headers arrive", () => {
  const controller = new AbortController();
  return Effect.gen(function* () {
    const cancelled = Promise.withResolvers<void>();
    const requested = Promise.withResolvers<void>();
    const port = serve(() => {
      requested.resolve();
      return new Response(
        new ReadableStream({
          start(stream): void {
            stream.enqueue(new TextEncoder().encode("partial"));
          },
          cancel: (): void => cancelled.resolve(),
        })
      );
    });
    const request = requestWorkerd({
      method: "GET",
      port,
      path: "/json",
      signal: controller.signal,
    });
    yield* Effect.tryPromise(() => requested.promise);
    controller.abort();
    const failure = yield* Effect.tryPromise(() => request).pipe(Effect.flip);
    expect(failure).toBeDefined();
    yield* Effect.tryPromise(() => cancelled.promise);
  });
});

it.each(["headers", "body"] as const)(
  "bounds full local HTTP %s lifetime without caller abort",
  (stall) =>
    Effect.runPromise(
      Effect.gen(function* () {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        const pending = Promise.withResolvers<Response>();
        try {
          const requested = Promise.withResolvers<void>();
          const cancelled = Promise.withResolvers<void>();
          const port = serve(() => {
            requested.resolve();
            return stall === "headers"
              ? pending.promise
              : new Response(
                  new ReadableStream({
                    start(stream): void {
                      stream.enqueue(new TextEncoder().encode("partial"));
                    },
                    cancel(): void {
                      cancelled.resolve();
                    },
                  })
                );
          });
          const signal = yield* Effect.abortSignal;
          const outcome = requestWorkerd({
            method: "GET",
            port,
            path: "/json",
            signal,
          }).then(
            () => "unexpected success",
            (failure: unknown) => failure
          );
          yield* Effect.tryPromise(() => requested.promise);
          yield* Effect.tryPromise(() => vi.advanceTimersByTimeAsync(30_001));
          expect(yield* Effect.tryPromise(() => outcome)).toMatchObject({ _tag: "TimeoutError" });
          if (stall === "body") {
            yield* Effect.tryPromise(() => cancelled.promise);
          }
        } finally {
          pending.resolve(Response.json([]));
          vi.useRealTimers();
        }
      }).pipe(Effect.scoped)
    )
);

it.live("aborts an in-flight request before response headers arrive", () => {
  const controller = new AbortController();
  return Effect.gen(function* () {
    const pending = Promise.withResolvers<Response>();
    const requested = Promise.withResolvers<void>();
    const port = serve(() => {
      requested.resolve();
      return pending.promise;
    });
    const request = requestWorkerd({
      method: "GET",
      port,
      path: "/json",
      signal: controller.signal,
    });
    yield* Effect.tryPromise(() => requested.promise);
    controller.abort();
    const failure = yield* Effect.tryPromise(() => request).pipe(Effect.flip);
    expect(failure).toBeDefined();
    pending.resolve(Response.json([]));
  });
});
