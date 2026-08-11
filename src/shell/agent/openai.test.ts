import { expect, it } from "@effect/vitest";
import { ConfigProvider, Context, Effect, Exit, Layer, Option, Ref, Schema } from "effect";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  makeOpenAiFunctionCallResponse,
  makeOpenAiTextResponse,
} from "~/shell/agent/fixtures/openai";
import {
  HostedInference,
  type HostedTextContinuation,
  type HostedTextRequest,
  HostedToolCallMaximum,
  makeHostedTextContext,
} from "./hosted-inference";
import {
  FidyAgentModel,
  HostedAgentGenerationConfig,
  OpenAiHostedInferenceLive,
  OpenAiHostedInferenceWithoutStartupValidation,
} from "./openai";
import { agentOperationBindings } from "./toolkit";

const configLayer = (entries: ReadonlyArray<readonly [string, string]>): Layer.Layer<never> =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(Object.fromEntries(entries)));

const JsonRecord = Schema.Record(Schema.String, Schema.Unknown);

const requestBody = Effect.fn("Test.requestBody")(function* (
  request: HttpClientRequest.HttpClientRequest
) {
  if (request.body._tag !== "Uint8Array") {
    return yield* Effect.die("Expected an encoded OpenAI request body");
  }
  const decoded = yield* Schema.decodeUnknownEffect(Schema.UnknownFromJsonString)(
    new TextDecoder().decode(request.body.body)
  );
  return yield* Schema.decodeUnknownEffect(JsonRecord)(decoded);
});

const makeTransport = Effect.fn("Test.makeTransport")(function* (
  inputTokens: number,
  responseBody: string = makeOpenAiTextResponse("ok")
) {
  const requests = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([]);
  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      yield* Ref.update(requests, (all) => [...all, request]);
      const body = request.url.includes("/responses/input_tokens")
        ? `{"object":"response.input_tokens","input_tokens":${inputTokens}}`
        : responseBody;
      return HttpClientResponse.fromWeb(
        request,
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    })
  );
  return { requests, layer: Layer.succeed(HttpClient.HttpClient, client) } as const;
});

const buildInference = Effect.fn("Test.buildInference")(function* (
  httpClient: Layer.Layer<HttpClient.HttpClient>,
  layer: typeof OpenAiHostedInferenceWithoutStartupValidation = OpenAiHostedInferenceWithoutStartupValidation
) {
  const context = yield* Effect.scoped(
    Layer.build(
      layer.pipe(
        Layer.provide(httpClient),
        Layer.provide(configLayer([["OPENAI_API_KEY", "test-only-secret"]]))
      )
    )
  );
  return Context.get(context, HostedInference);
});

const textRequest = (): HostedTextRequest => ({
  context: makeHostedTextContext({
    prefix: [{ role: "system", content: "system framing" }],
    continuationTail: [],
    suffix: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  }),
  continuation: Option.none(),
  toolChoice: "auto",
  maximumToolCalls: HostedToolCallMaximum.make(12),
});

const continuationRequest = (
  continuation: HostedTextContinuation,
  callId: string
): HostedTextRequest => ({
  context: makeHostedTextContext({
    prefix: [{ role: "system", content: "system framing" }],
    continuationTail: [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: callId,
            name: agentOperationBindings[0]?.wireName ?? "get_transactions",
            result: { status: "completed" },
            isFailure: false,
          },
        ],
      },
    ],
    suffix: [{ role: "user", content: [{ type: "text", text: "continue" }] }],
  }),
  continuation: Option.some(continuation),
  toolChoice: "auto",
  maximumToolCalls: HostedToolCallMaximum.make(12),
});

it.effect("fails closed when the OpenAI secret is absent", () =>
  Effect.gen(function* () {
    const transport = yield* makeTransport(100);
    const unconfigured = OpenAiHostedInferenceWithoutStartupValidation.pipe(
      Layer.provide(transport.layer),
      Layer.provide(configLayer([]))
    );

    const exit = yield* Effect.exit(Effect.scoped(Layer.build(unconfigured)));
    expect(Exit.isFailure(exit)).toBe(true);
  })
);

it.effect("counts complete framing and executes the exact prepared request", () =>
  Effect.gen(function* () {
    const transport = yield* makeTransport(100);
    const inference = yield* buildInference(transport.layer);
    const prepared = yield* inference.prepareText(textRequest());
    const result = yield* inference.executeText(prepared);
    expect(result.text).toBe("ok");

    const [count, execute] = yield* Ref.get(transport.requests);
    if (count === undefined || execute === undefined) return yield* Effect.die("missing requests");
    expect(count.url).toContain("/responses/input_tokens");
    expect(execute.url).toContain("/responses");
    const countJson = yield* requestBody(count);
    const executeJson = yield* requestBody(execute);

    expect(executeJson.model).toBe(FidyAgentModel);
    expect(executeJson.max_output_tokens).toBe(16_000);
    expect(executeJson.max_tool_calls).toBe(12);
    expect(executeJson.parallel_tool_calls).toBe(false);
    expect(executeJson.store).toBe(false);
    expect(executeJson.temperature).toBe(HostedAgentGenerationConfig.temperature);
    expect(countJson.input).toEqual(executeJson.input);
    expect(countJson.tools).toEqual(executeJson.tools);
    expect(countJson.tool_choice).toEqual(executeJson.tool_choice);
    expect(countJson.parallel_tool_calls).toEqual(executeJson.parallel_tool_calls);
    const tools = yield* Schema.decodeUnknownEffect(
      Schema.Array(Schema.Struct({ name: Schema.String }))
    )(executeJson.tools);
    expect(tools.map(({ name }) => name).toSorted()).toEqual(
      agentOperationBindings.map(({ wireName }) => wireName).toSorted()
    );
  })
);

it.effect("accumulates provider output and canonical outcomes across three rounds", () =>
  Effect.gen(function* () {
    const transport = yield* makeTransport(100);
    const inference = yield* buildInference(transport.layer);
    const first = yield* inference
      .prepareText(textRequest())
      .pipe(Effect.flatMap(inference.executeText));
    const second = yield* inference
      .prepareText(continuationRequest(first.continuation, "call_first"))
      .pipe(Effect.flatMap(inference.executeText));
    yield* inference
      .prepareText(continuationRequest(second.continuation, "call_second"))
      .pipe(Effect.flatMap(inference.executeText));

    const requests = yield* Ref.get(transport.requests);
    const thirdCount = requests[4];
    if (thirdCount === undefined) return yield* Effect.die("missing third-round count request");
    const input = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(
      (yield* requestBody(thirdCount)).input
    );
    expect(input.split('"type":"output_text"')).toHaveLength(3);
    expect(input).toContain("call_first");
    expect(input).toContain("call_second");
  })
);

it.effect("rejects malformed provider responses", () =>
  Effect.gen(function* () {
    const transport = yield* makeTransport(100, "{}");
    const inference = yield* buildInference(transport.layer);
    const prepared = yield* inference.prepareText(textRequest());
    const failure = yield* inference.executeText(prepared).pipe(Effect.flip);
    expect(failure.reason).toEqual({
      _tag: "InvalidOutput",
      description: "Hosted provider response was invalid",
    });
  })
);

it.effect("rejects malformed tool-call arguments", () =>
  Effect.gen(function* () {
    const transport = yield* makeTransport(
      100,
      makeOpenAiFunctionCallResponse({ name: "get_transactions", argumentsJson: "{" })
    );
    const inference = yield* buildInference(transport.layer);
    const prepared = yield* inference.prepareText(textRequest());
    const failure = yield* inference.executeText(prepared).pipe(Effect.flip);
    expect(failure.reason).toEqual({
      _tag: "InvalidOutput",
      description: "Hosted tool arguments were invalid",
    });
  })
);

it.effect("rejects complete-capacity overflow before execution", () =>
  Effect.gen(function* () {
    const transport = yield* makeTransport(1_034_001);
    const inference = yield* buildInference(transport.layer);
    const failure = yield* inference.prepareText(textRequest()).pipe(Effect.flip);
    expect(failure.reason._tag).toBe("CapacityExceeded");
    expect(yield* Ref.get(transport.requests)).toHaveLength(1);
  })
);

it.effect("runs non-executable startup validation through the same preparer", () =>
  Effect.gen(function* () {
    const transport = yield* makeTransport(100);
    yield* buildInference(transport.layer, OpenAiHostedInferenceLive);
    const requests = yield* Ref.get(transport.requests);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toContain("/responses/input_tokens");
  })
);
