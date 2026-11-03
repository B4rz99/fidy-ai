import { expect, it } from "@effect/vitest";
import { Effect, Exit, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { makeOperatorD1Http } from "./operations";

it.effect(
  "refuses missing operator credentials or invalid database destinations before sending work",
  () =>
    Effect.gen(function* () {
      let calls = 0;
      const client = HttpClient.make((request) => {
        calls++;
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}")));
      });
      for (const config of [
        {
          accountId: "a".repeat(32),
          databaseId: "10000000-0000-4000-8000-000000000001",
          token: "",
        },
        {
          accountId: "bad/host",
          databaseId: "10000000-0000-4000-8000-000000000001",
          token: "synthetic",
        },
        { accountId: "a".repeat(32), databaseId: "../other", token: "synthetic" },
      ]) {
        const http = makeOperatorD1Http({ ...config, client, token: Redacted.make(config.token) });
        expect(Exit.isFailure(yield* Effect.exit(http.execute("{}")))).toBe(true);
      }
      expect(calls).toBe(0);
    })
);

it.effect("bounds operator database responses without trusting content length", () =>
  Effect.gen(function* () {
    const client = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("x".repeat(262145))))
    );
    const http = makeOperatorD1Http({
      client,
      accountId: "a".repeat(32),
      databaseId: "10000000-0000-4000-8000-000000000001",
      token: Redacted.make("synthetic"),
    });
    expect(Exit.isFailure(yield* Effect.exit(http.execute("{}")))).toBe(true);
  })
);
