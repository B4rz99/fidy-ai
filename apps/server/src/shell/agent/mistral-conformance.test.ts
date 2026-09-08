import { UnknownJsonString } from "~/schema-compatibility";
import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Redacted, Ref, Schema } from "effect";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { type MistralV13Messages, countMistralV13Messages } from "./mistral-tokenizer";
import { MistralConformanceModel, verifyMistralTokenConformance } from "./mistral-conformance";

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

const responseBody = (promptTokens: number, content: string): string =>
  JSON.stringify({
    id: "probe",
    object: "chat.completion",
    created: 1,
    model: MistralConformanceModel,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content, prefix: false, tool_calls: null },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: promptTokens + 1 },
  });

const validContents = [
  "baseline",
  JSON.stringify({ name: "To Kill a Mockingbird", authors: ["Harper Lee"] }),
  JSON.stringify({ name: "To Kill a Mockingbird", authors: ["Harper Lee"] }),
  JSON.stringify({ compactedConversation: "The User tracks a grocery budget." }),
] as const;

const makeTransport = Effect.fn("Test.makeMistralTransport")(function* (
  alterResponse?: (index: number, promptTokens: number, content: string) => string
) {
  const requests = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([]);
  const invocation = yield* Ref.make(0);
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      const index = yield* Ref.getAndUpdate(invocation, (value) => value + 1);
      yield* Ref.update(requests, (all) => [...all, request]);
      const body = yield* decodeRequest(request).pipe(Effect.orDie);
      const messages: MistralV13Messages = yield* Schema.decodeUnknownEffect(MistralMessages)(
        body.messages
      ).pipe(Effect.orDie);
      const promptTokens = countMistralV13Messages(messages);
      const content = validContents[index] ?? "";
      return HttpClientResponse.fromWeb(
        request,
        new Response(
          alterResponse?.(index, promptTokens, content) ?? responseBody(promptTokens, content),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          }
        )
      );
    })
  );
  return { client, requests } as const;
});

it.effect("sends schema differentials and the production Compaction reserve", () =>
  Effect.gen(function* () {
    const { client, requests } = yield* makeTransport();
    const reports = yield* verifyMistralTokenConformance(
      Redacted.make("credential-private-sentinel")
    ).pipe(Effect.provideService(HttpClient.HttpClient, client));
    const sent = yield* Ref.get(requests);
    const bodies = yield* Effect.forEach(sent, decodeRequest);

    expect(reports.map((report) => report.id)).toEqual([
      "baseline",
      "small-schema",
      "large-schema",
      "production-compaction",
    ]);
    expect(reports.slice(0, 3).map((report) => report.hostedPromptTokens)).toEqual([23, 23, 23]);
    expect(bodies[0]?.response_format).toBeUndefined();
    expect(bodies[1]?.response_format).toBeDefined();
    expect(bodies[2]?.response_format).toBeDefined();
    expect(bodies[3]).toMatchObject({
      model: MistralConformanceModel,
      max_tokens: 16_000,
      temperature: 0,
    });
    expect(reports[3]?.completeRequestTokens).toBe((reports[3]?.localPromptTokens ?? 0) + 16_000);
  })
);

it.effect("rejects excess structured output without exposing the credential or provider body", () =>
  Effect.gen(function* () {
    const secret = "credential-private-sentinel";
    const privateBody = "response-private-sentinel";
    const { client } = yield* makeTransport((index, promptTokens, content) =>
      index === 1
        ? responseBody(
            promptTokens,
            JSON.stringify({ name: privateBody, authors: [], unexpected: "hostile" })
          )
        : responseBody(promptTokens, content)
    );
    const exit = yield* verifyMistralTokenConformance(Redacted.make(secret)).pipe(
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.exit
    );

    expect(exit).toMatchObject({ _tag: "Failure" });
    if (Exit.isFailure(exit)) {
      const rendered = Cause.pretty(exit.cause);
      const failure = exit.cause.reasons.find(Cause.isFailReason);
      expect(failure).toMatchObject({ error: { reason: "structured_output_invalid" } });
      expect(rendered).not.toContain(secret);
      expect(rendered).not.toContain(privateBody);
      expect(rendered).not.toContain("hostile");
    }
  })
);

it.effect("rejects malformed provider envelopes and oversized responses", () =>
  Effect.gen(function* () {
    const malformed = yield* makeTransport((index, promptTokens, content) =>
      index === 0
        ? JSON.stringify({
            id: "probe",
            object: "chat.completion",
            created: 1,
            model: MistralConformanceModel,
            choices: [],
            usage: { prompt_tokens: promptTokens, completion_tokens: 1, total_tokens: 1 },
            unexpected: content,
          })
        : responseBody(promptTokens, content)
    );
    const malformedExit = yield* verifyMistralTokenConformance(Redacted.make("secret")).pipe(
      Effect.provideService(HttpClient.HttpClient, malformed.client),
      Effect.exit
    );

    const oversizedClient = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("x".repeat(1_000_001))))
    );
    const oversizedExit = yield* verifyMistralTokenConformance(Redacted.make("secret")).pipe(
      Effect.provideService(HttpClient.HttpClient, oversizedClient),
      Effect.exit
    );

    expect(malformedExit).toMatchObject({ _tag: "Failure" });
    expect(oversizedExit).toMatchObject({ _tag: "Failure" });
  })
);
