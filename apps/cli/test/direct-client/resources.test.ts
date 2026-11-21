import { ownNativeFetch } from "@fidy/server/native-http";
import { expect, it, layer } from "@effect/vitest";
import { Data, Effect, Exit, Fiber, Match, Option, Result } from "effect";
import { TestClock } from "effect/testing";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientResponse } from "effect/http";
import { isCliFailure } from "../../src/credential/contract";
import { protectClient } from "../../src/direct-client/runtime";

class NativeLifetimeTestFailed extends Data.TaggedError("NativeLifetimeTestFailed")<{
  readonly cause: unknown;
}> {}

layer(FetchHttpClient.layer)((it) => {
  it.effect(
    "preserves native no-content success and decodes an empty body without leaking its reader",
    () =>
      Effect.gen(function* () {
        let cancelled = false;

        const body = new ReadableStream<unknown>({
          cancel(): Promise<void> {
            cancelled = true;

            return Promise.withResolvers<void>().promise;
          },
        });

        const native = new Response(null, { status: 204 });
        Object.defineProperty(native, "body", { value: body });
        const client = yield* HttpClient.HttpClient;

        const response = yield* protectClient(client)
          .get("https://api.fidyapp.com/pat-pairings")
          .pipe(
            Effect.provideService(
              FetchHttpClient.Fetch,
              Object.assign(() => Promise.resolve(native), { preconnect: fetch.preconnect })
            )
          );

        expect(response.status).toBe(204);
        expect(yield* response.text).toBe("");
        expect(cancelled).toBe(true);
        expect(body.locked).toBe(false);
      })
  );

  it.effect(
    "keeps rejected native cancellation out of the public failure and releases ownership",
    () =>
      Effect.gen(function* () {
        const body = new ReadableStream<unknown>({
          start(controller): void {
            controller.enqueue(new Uint8Array(16_385));
          },
          cancel(): Promise<void> {
            return Promise.reject(new Error("private adapter details"));
          },
        });

        const client = yield* HttpClient.HttpClient;

        const result = yield* protectClient(client)
          .get("https://api.fidyapp.com/pat-pairings")
          .pipe(
            Effect.result,
            Effect.provideService(
              FetchHttpClient.Fetch,
              Object.assign(() => Promise.resolve(new Response(body)), {
                preconnect: fetch.preconnect,
              })
            )
          );

        expect(result).toMatchObject({ failure: { reason: "TransportUnavailable" } });
        expect(body.locked).toBe(false);
      })
  );

  it.effect.each([
    "overflow",
    "deadline",
    "interruption",
    "success",
    "read failure",
    "invalid chunk",
  ] as const)(
    "releases the native response reader on %s even if cancel never settles",
    (completion) =>
      Effect.gen(function* () {
        let cancelled = false;

        const body = new ReadableStream<unknown>({
          start(controller): void {
            if (completion === "overflow") controller.enqueue(new Uint8Array(16_385));

            if (completion === "success") {
              controller.enqueue(new Uint8Array());
              controller.enqueue(new TextEncoder().encode("{}"));
              controller.close();
            }

            if (completion === "read failure") controller.error(new Error("source unavailable"));

            if (completion === "invalid chunk") controller.enqueue("private invalid bytes");
          },
          cancel(): Promise<void> {
            cancelled = true;

            return Promise.withResolvers<void>().promise;
          },
        });

        const client = yield* HttpClient.HttpClient;

        const request = protectClient(client)
          .get("https://api.fidyapp.com/pat-pairings")
          .pipe(
            Effect.provideService(
              FetchHttpClient.Fetch,
              Object.assign(() => Promise.resolve(new Response(body)), {
                preconnect: fetch.preconnect,
              })
            )
          );

        const fiber = yield* request.pipe(Effect.result, Effect.forkChild);

        yield* TestClock.adjust(completion === "interruption" ? "1 second" : "16 seconds");

        if (completion === "interruption") yield* Fiber.interrupt(fiber);

        const exit = yield* Fiber.await(fiber);

        expect(
          Exit.match(exit, {
            onFailure: () => "interrupted",
            onSuccess: Result.match({
              onSuccess: () => "success",
              onFailure: (failure) => (isCliFailure(failure) ? failure.reason : "unexpected"),
            }),
          })
        ).toBe(
          Match.value(completion).pipe(
            Match.when("interruption", () => "interrupted"),
            Match.when("success", () => "success"),
            Match.orElse(() => "TransportUnavailable")
          )
        );

        expect(body.locked).toBe(false);
        expect(cancelled).toBe(completion !== "success" && completion !== "read failure");
      })
  );
});

it.effect("cancels a dishonest oversized response before decoding it", () =>
  Effect.gen(function* () {
    let cancelled = false;
    const tooManyBytes = 20_000;

    const body = new ReadableStream<unknown>({
      start: (controller): void => {
        controller.enqueue(new Uint8Array(tooManyBytes));
      },
      cancel: (): void => {
        cancelled = true;
      },
    });

    const raw = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(body, { headers: { "content-length": "1" } })
        )
      )
    );

    const result = yield* Effect.exit(
      protectClient(raw).get("https://api.fidyapp.com/pat-pairings")
    );

    expect(Exit.isFailure(result)).toBe(true);
    expect(cancelled).toBe(true);
  })
);

it.effect("Ctrl-C style interruption aborts the request and cancels its pending reader", () =>
  Effect.gen(function* () {
    let cancelled = false;
    let aborted = false;

    const body = new ReadableStream<unknown>({
      cancel: (): void => {
        cancelled = true;
      },
    });

    const raw = HttpClient.make((request, _url, signal) => {
      signal.addEventListener(
        "abort",
        () => {
          aborted = true;
        },
        { once: true }
      );

      return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body)));
    });

    const fiber = yield* protectClient(raw)
      .get("https://api.fidyapp.com/pat-pairings")
      .pipe(Effect.forkChild);

    yield* TestClock.adjust("1 second");
    yield* Fiber.interrupt(fiber);
    expect(cancelled).toBe(true);
    expect(aborted).toBe(true);
  })
);

it.effect(
  "refuses foreign origins, redirects and oversized requests without sending their body elsewhere",
  () =>
    Effect.gen(function* () {
      let sent = false;

      const raw = HttpClient.make((request) =>
        Effect.sync(() => {
          sent = true;

          return HttpClientResponse.fromWeb(
            request,
            new Response("{}", { status: 302, headers: { location: "https://attacker.example" } })
          );
        })
      );

      expect(
        Exit.isFailure(yield* Effect.exit(protectClient(raw).get("https://attacker.example")))
      ).toBe(true);
      expect(sent).toBe(false);

      const result = yield* Effect.exit(
        protectClient(raw).get("https://api.fidyapp.com/pat-pairings")
      );

      expect(Exit.isFailure(result)).toBe(true);
      expect(sent).toBe(true);
      sent = false;
      const requestCharacters = 20_000;

      const oversized = yield* Effect.exit(
        protectClient(raw).post("https://api.fidyapp.com/pat-pairings", {
          body: HttpBody.text("x".repeat(requestCharacters)),
        })
      );

      expect(Exit.isFailure(oversized)).toBe(true);
      expect(sent).toBe(false);
    })
);

it.effect.each(["inherited", "undefined", "null", "replacement"] as const)(
  "honors %s Fetch signal precedence",
  (mode) => {
    const original = new AbortController();
    const replacement = new AbortController();

    return Effect.gen(function* () {
      const body = new ReadableStream<Uint8Array>();

      const native = Object.assign(() => Promise.resolve(new Response(body)), {
        preconnect: fetch.preconnect,
      });

      const request = new Request("https://api.fidyapp.com/pat-pairings", {
        signal: original.signal,
      });

      let init: RequestInit = {};

      if (mode === "null") init = { signal: null };

      if (mode === "replacement") init = { signal: replacement.signal };

      if (mode === "undefined") init = { signal: undefined };
      const reference = new Request(request, init);

      const response = yield* Effect.tryPromise({
        try: () => ownNativeFetch(native)(request, init),
        catch: (cause: unknown) => new NativeLifetimeTestFailed({ cause }),
      });

      const reader = Option.getOrThrow(Option.fromNullishOr(response.body)).getReader();
      const pending = reader.read();

      const failed =
        mode === "null" ? pending : expect(pending).rejects.toThrow("Response body aborted");

      original.abort("private request reason");
      expect(reference.signal.aborted).toBe(mode === "inherited" || mode === "undefined");
      expect(body.locked).toBe(!reference.signal.aborted);

      if (mode === "null") {
        yield* Effect.tryPromise({
          try: () => reader.cancel(),
          catch: (cause: unknown) => new NativeLifetimeTestFailed({ cause }),
        });
      }

      if (mode === "replacement") replacement.abort();
      yield* Effect.tryPromise({
        try: () => failed.then(() => undefined),
        catch: (cause: unknown) => new NativeLifetimeTestFailed({ cause }),
      });
      expect(body.locked).toBe(false);
    });
  }
);

it.effect.each([204, 205, 304])(
  "disposes an anomalous %s body immediately without reading bytes",
  (status) =>
    Effect.gen(function* () {
      let reads = 0;
      let cancellations = 0;
      const body = new ReadableStream<Uint8Array>({}, { highWaterMark: 0 });
      const acquire = body.getReader.bind(body);
      Object.defineProperty(body, "getReader", {
        value: (): ReturnType<typeof acquire> => {
          const reader = acquire();
          reader.read = (): ReturnType<typeof reader.read> => {
            reads++;

            return Promise.resolve({ done: false, value: new Uint8Array([1]) });
          };

          reader.cancel = (): Promise<void> => {
            cancellations++;
            throw new Error("private disposal failure");
          };

          return reader;
        },
      });

      const native = new Response(null, {
        status,
        statusText: "Protocol status",
        headers: { "x-response": "retained" },
      });

      Object.defineProperty(native, "body", { value: body });

      const response = yield* Effect.tryPromise({
        try: () =>
          ownNativeFetch(
            Object.assign(() => Promise.resolve(native), { preconnect: fetch.preconnect })
          )("https://api.fidyapp.com/pat-pairings"),
        catch: (cause: unknown) => new NativeLifetimeTestFailed({ cause }),
      });

      expect(response.status).toBe(status);
      expect(response.statusText).toBe("Protocol status");
      expect(response.headers.get("x-response")).toBe("retained");
      expect(response.body).toBeNull();
      expect(reads).toBe(0);
      expect(cancellations).toBe(1);
      expect(body.locked).toBe(false);
    })
);
