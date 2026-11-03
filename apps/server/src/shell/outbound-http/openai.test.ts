import { strict as assert } from "node:assert";
import { OutboundHttpFailure } from "./contract";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Option, Redacted } from "effect";
import { FetchHttpClient, Headers, HttpClient, HttpClientResponse } from "effect/http";
import { makeOpenAiOutboundHttp } from "./operations";

it.effect("uses the fixed OpenAI destination without redirect authority or trace propagation", () =>
  Effect.gen(function* () {
    let calls = 0;
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        calls += 1;
        expect(request.url).toBe("https://api.openai.com/v1/chat/completions");
        expect(request.method).toBe("POST");
        expect(request.headers.authorization).toBe("Bearer synthetic-api-key");
        expect(request.headers).not.toHaveProperty("traceparent");
        const init = yield* Effect.serviceOption(FetchHttpClient.RequestInit);
        expect(Option.getOrUndefined(init)).toMatchObject({
          redirect: "manual",
          credentials: "omit",
        });
        return HttpClientResponse.fromWeb(request, Response.json({ choices: [] }));
      })
    );
    const http = makeOpenAiOutboundHttp({ apiKey: Redacted.make("synthetic-api-key"), client });
    const result = yield* http.execute('{"model":"gpt-6-luna","store":false}');
    expect(result.status).toBe(200);
    expect(new TextDecoder().decode(result.body)).toBe('{"choices":[]}');
    expect(calls).toBe(1);
  })
);

it.effect("bounds streamed OpenAI response bytes and performs no hidden retry", () =>
  Effect.gen(function* () {
    let calls = 0;
    let cancelled = false;
    const client = HttpClient.make((request) => {
      calls += 1;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            new ReadableStream({
              start: (controller): void => controller.enqueue(new Uint8Array(524_289)),
              cancel: (): void => {
                cancelled = true;
              },
            })
          )
        )
      );
    });
    const http = makeOpenAiOutboundHttp({ apiKey: Redacted.make("synthetic-api-key"), client });
    assert.deepStrictEqual(
      Exit.fail(yield* Effect.flip(http.execute("{}"))),
      Exit.fail(
        new OutboundHttpFailure({
          reason: "response-too-large",
          responseStatus: Option.some(200),
          responseHeaders: Headers.empty,
        })
      )
    );
    expect(calls).toBe(1);
    expect(cancelled).toBe(true);
  })
);
