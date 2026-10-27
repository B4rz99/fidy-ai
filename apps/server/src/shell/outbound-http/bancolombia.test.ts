import { expect, it } from "@effect/vitest";
import { Effect, Option, Redacted } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import { makeBancolombiaSandboxOutboundHttp } from "./operations";

it.effect(
  "keeps Bancolombia assertions at the fixed sandbox token endpoint and refuses redirects",
  () =>
    Effect.gen(function* () {
      const requests: string[] = [];
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          requests.push(request.url);
          expect(
            Option.getOrThrow(yield* Effect.serviceOption(FetchHttpClient.RequestInit)).redirect
          ).toBe("manual");
          expect(request.headers.authorization).toBeUndefined();
          return HttpClientResponse.fromWeb(
            request,
            new Response("", {
              status: 302,
              headers: { location: "https://foreign.example/token" },
            })
          );
        })
      );
      const bank = makeBancolombiaSandboxOutboundHttp(client);
      const result = yield* bank.execute({
        _tag: "Authenticate",
        assertion: Redacted.make("synthetic-assertion"),
      });
      expect(result.status).toBe(302);
      expect(result.headers).toEqual({});
      expect(requests).toEqual(["https://as1-api-open-finance-sandbox.ambientesbc.com/token"]);
    })
);
