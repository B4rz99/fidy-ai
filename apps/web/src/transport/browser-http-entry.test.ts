// @vitest-environment node
import { Context, Deferred, Effect, Fiber, Layer } from "effect";
import { TestClock } from "effect/testing";
import {
  HttpClient,
  type HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";
import { expect, it } from "@effect/vitest";
import { browserHttpClientLayer } from "./browser-http-policy";

// Keep this test isolated from the assembled API: ordinary channel clients must not need it.
it.effect("paces a declared unadmitted mutation without loading the bootstrap API", () =>
  Effect.gen(function* () {
    const started = Deferred.makeUnsafe<void>();
    let attempts = 0;
    const respond = Effect.fn(function* (request: HttpClientRequest.HttpClientRequest) {
      attempts++;
      yield* Deferred.succeed(started, undefined);
      return HttpClientResponse.fromWeb(
        request,
        Response.json(
          attempts === 1
            ? { error: { code: "rate_limited", message: "Retry later." }, next: [] }
            : { data: "accepted", next: [] },
          { status: attempts === 1 ? 429 : 200, headers: { "retry-after": "1" } }
        )
      );
    });
    const transport = HttpClient.makeWith(
      (
        request: Effect.Effect<HttpClientRequest.HttpClientRequest, HttpClientError.HttpClientError>
      ) => Effect.flatMap(request, respond),
      Effect.succeed
    );
    const context = yield* Layer.build(
      Layer.succeed(HttpClient.HttpClient, transport).pipe(
        browserHttpClientLayer("canonical", "https://api.test.fidyapp.com")
      )
    );
    const client = Context.get(context, HttpClient.HttpClient);
    const work = yield* Effect.forkChild(
      client.execute(HttpClientRequest.post("https://api.test.fidyapp.com/dashboard/initialize"))
    );
    yield* Deferred.await(started);
    expect(attempts).toBe(1);
    yield* TestClock.adjust("1 second");
    const response = yield* Fiber.join(work);
    expect(response.status).toBe(200);
    expect(attempts).toBe(2);
    expect(yield* response.json).toEqual({ data: "accepted", next: [] });
  })
);
