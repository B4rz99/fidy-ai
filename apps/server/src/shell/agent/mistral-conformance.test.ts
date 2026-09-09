import { UnknownJsonString } from "~/schema-compatibility";
import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Redacted, Ref, Schema } from "effect";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { type MistralV13Messages, countMistralV13Messages } from "./mistral-tokenizer";
import { mistralConformanceModel, verifyMistralTokenConformance } from "./mistral-conformance";

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);
const MistralMessage = Schema.Struct({
  role: Schema.Literals(["system", "user", "assistant"]),
  content: Schema.String,
});
const MistralMessages = Schema.TupleWithRest(
  Schema.Tuple([
    Schema.Struct({ role: Schema.Literal("system"), content: Schema.String }),
    Schema.Struct({ role: Schema.Literal("user"), content: Schema.String }),
  ]),
  [MistralMessage]
);

const decodeRequest = Effect.fn("Test.decodeMistralRequest")(function* (
  request: HttpClientRequest.HttpClientRequest
) {
  if (request.body._tag !== "Uint8Array") return yield* Effect.die("missing request body");
  const json = yield* Schema.decodeEffect(UnknownJsonString)(
    new TextDecoder().decode(request.body.body)
  );
  return yield* Schema.decodeUnknownEffect(JsonRecord)(json);
});

type AccountingResponse = Readonly<{
  model: string;
  usage: Readonly<{ prompt_tokens: number }>;
}>;

const makeAccountingClient = (
  requests: Ref.Ref<ReadonlyArray<HttpClientRequest.HttpClientRequest>>,
  responseForPromptTokens: (promptTokens: number) => AccountingResponse = (promptTokens) => ({
    model: mistralConformanceModel,
    usage: { prompt_tokens: promptTokens },
  })
): HttpClient.HttpClient =>
  HttpClient.make((request) =>
    Effect.gen(function* () {
      yield* Ref.update(requests, (all) => [...all, request]);
      const body = yield* decodeRequest(request).pipe(Effect.orDie);
      const messages: MistralV13Messages = yield* Schema.decodeUnknownEffect(MistralMessages)(
        body.messages
      ).pipe(Effect.orDie);
      const promptTokens = countMistralV13Messages(messages);
      const responseBody = yield* Schema.encodeEffect(UnknownJsonString)(
        responseForPromptTokens(promptTokens)
      ).pipe(Effect.orDie);
      return HttpClientResponse.fromWeb(request, new Response(responseBody, { status: 200 }));
    })
  );

it.effect("sends schema differentials and the production Compaction reserve", () =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([]);
    const client = makeAccountingClient(requests);

    const reports = yield* verifyMistralTokenConformance(Redacted.make("secret")).pipe(
      Effect.provideService(HttpClient.HttpClient, client)
    );
    const sent = yield* Ref.get(requests);
    const bodies = yield* Effect.forEach(sent, decodeRequest);

    expect(reports.map((report) => report.id)).toEqual([
      "baseline",
      "small-schema",
      "large-schema",
      "production-compaction",
    ]);
    expect(bodies[0]?.response_format).toBeUndefined();
    expect(bodies[1]?.response_format).toBeDefined();
    expect(bodies[2]?.response_format).toBeDefined();
    expect(bodies[3]).toMatchObject({
      model: mistralConformanceModel,
      max_tokens: 16_000,
      temperature: 0,
    });
    expect(reports[3]?.completeRequestTokens).toBe((reports[3]?.localPromptTokens ?? 0) + 16_000);
  })
);

it.effect("rejects provider identity and prompt accounting disagreement", () =>
  Effect.gen(function* () {
    const probes = [
      {
        reason: "provider_model_mismatch",
        response: (promptTokens: number): AccountingResponse => ({
          model: "different-model",
          usage: { prompt_tokens: promptTokens },
        }),
      },
      {
        reason: "prompt_count_mismatch",
        response: (promptTokens: number): AccountingResponse => ({
          model: mistralConformanceModel,
          usage: { prompt_tokens: promptTokens + 1 },
        }),
      },
    ] as const;

    for (const probe of probes) {
      const requests = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([]);
      const failure = yield* verifyMistralTokenConformance(Redacted.make("secret")).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          makeAccountingClient(requests, probe.response)
        ),
        Effect.flip
      );
      expect(failure.reason).toBe(probe.reason);
    }
  })
);

it.effect("fails without exposing the credential or provider body", () =>
  Effect.gen(function* () {
    const secret = "credential-private-sentinel";
    const privateBody = "response-private-sentinel";
    const client = HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(request, new Response(privateBody, { status: 500 }))
      )
    );
    const exit = yield* verifyMistralTokenConformance(Redacted.make(secret)).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.exit
    );

    expect(exit).toMatchObject({ _tag: "Failure" });
    if (Exit.isFailure(exit)) {
      const rendered = Cause.pretty(exit.cause);
      expect(rendered).not.toContain(secret);
      expect(rendered).not.toContain(privateBody);
    }
  })
);
