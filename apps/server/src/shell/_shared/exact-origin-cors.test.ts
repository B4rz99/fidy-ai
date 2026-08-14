import { expect, it } from "@effect/vitest";
import { Effect, Ref } from "effect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { makeExactOriginCors } from "./exact-origin-cors";

const applyCors = (
  request: Request,
  response: Effect.Effect<HttpServerResponse.HttpServerResponse>
): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
  makeExactOriginCors({
    allowedOrigin: "https://fidyapp.com",
    methods: ["GET", "POST"],
  })(response).pipe(
    Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request))
  );

it.effect("rejects an unconfigured Origin without executing route behavior", () =>
  Effect.gen(function* () {
    const executions = yield* Ref.make(0);
    const route = Ref.update(executions, (count) => count + 1).pipe(
      Effect.as(HttpServerResponse.empty({ status: 200 }))
    );

    const response = yield* applyCors(
      new Request("https://api.fidyapp.com/user", {
        headers: { origin: "https://attacker.example" },
      }),
      route
    );

    expect(response.status).toBe(403);
    expect(response.headers.vary).toBe("Origin");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(yield* Ref.get(executions)).toBe(0);
  })
);

it.effect("preserves existing response variation for an accepted Origin", () =>
  Effect.gen(function* () {
    const response = yield* applyCors(
      new Request("https://api.fidyapp.com/user", {
        headers: { origin: "https://fidyapp.com" },
      }),
      Effect.succeed(
        HttpServerResponse.empty({
          status: 200,
          headers: { vary: "Accept-Encoding" },
        })
      )
    );

    expect(response.headers.vary).toBe("Accept-Encoding, Origin");
    expect(response.headers["access-control-allow-origin"]).toBe("https://fidyapp.com");
  })
);
