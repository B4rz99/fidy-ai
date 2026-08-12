import { expect, it } from "@effect/vitest";
import {
  ConfigProvider,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
} from "effect";
import { TestClock } from "effect/testing";
import { LanguageModel } from "effect/unstable/ai";
import { HttpClient, type HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import {
  makeOpenAiFunctionCallResponse,
  makeOpenAiTextResponse,
} from "~/shell/agent/fixtures/openai";
import {
  HostedInference,
  HostedStructuredObjectName,
  type HostedStructuredRequest,
  type HostedTextContinuation,
  type HostedTextRequest,
  HostedToolCallMaximum,
  makeHostedStructuredContext,
  makeHostedTextContext,
} from "./hosted-inference";
import {
  FidyAgentModel,
  HostedAgentGenerationConfig,
  OpenAiHostedInferenceLive,
  OpenAiHostedInferenceWithoutStartupValidation,
  OpenAiLanguageModelLive,
  makeOpenAiHarness,
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
  responseBody: string = makeOpenAiTextResponse("ok"),
  executionHeaders: Readonly<Record<string, string>> = {}
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
          headers: {
            "content-type": "application/json",
            ...(request.url.includes("/responses/input_tokens") ? {} : executionHeaders),
          },
        })
      );
    })
  );
  return { requests, layer: Layer.succeed(HttpClient.HttpClient, client) } as const;
});

const makeExecutionFailingTransport = (
  status: number,
  body: string
): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          request.url.includes("/responses/input_tokens")
            ? new Response('{"object":"response.input_tokens","input_tokens":100}', {
                status: 200,
                headers: { "content-type": "application/json" },
              })
            : new Response(body, { status })
        )
      )
    )
  );

const makeFailingTransport = (status: number): Layer.Layer<HttpClient.HttpClient> =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("", { status })))
    )
  );

const amendResponse = (body: string, patch: Readonly<Record<string, unknown>>): string => {
  const decoded = Schema.decodeSync(Schema.UnknownFromJsonString)(body);
  if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) {
    throw new Error("Expected an OpenAI response object");
  }
  return Schema.encodeSync(Schema.UnknownFromJsonString)({ ...decoded, ...patch });
};

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

it.effect("builds the structured-output LanguageModel adapter", () =>
  Effect.gen(function* () {
    const transport = yield* makeTransport(1);
    const context = yield* Effect.scoped(
      Layer.build(
        OpenAiLanguageModelLive.pipe(
          Layer.provide(transport.layer),
          Layer.provide(configLayer([["OPENAI_API_KEY", "test-only-secret"]]))
        )
      )
    );
    expect(Context.get(context, LanguageModel.LanguageModel)).toBeDefined();
  })
);

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

const StructuredOutput = Schema.Struct({
  compactedConversation: Schema.String,
  optionalLabel: Schema.optionalKey(Schema.String),
});

const structuredRequest = (): HostedStructuredRequest<
  typeof StructuredOutput.Type,
  typeof StructuredOutput.Encoded
> => ({
  context: makeHostedStructuredContext({
    messages: [{ role: "user" as const, content: "compact exact retained conversation" }],
  }),
  objectName: HostedStructuredObjectName.make("compacted_conversation"),
  outputSchema: StructuredOutput,
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

it.effect("counts Memory aggregates locally with o200k_base without provider requests", () =>
  Effect.gen(function* () {
    const transport = yield* makeTransport(100);
    const inference = yield* buildInference(transport.layer);
    const samples = [
      ["a", 1],
      ["hello world", 2],
      ["Pago mensual de arriendo en Bogotá", 7],
      ["Emoji 👩🏽‍💻, café, 漢字\r\nfin", 16],
      [
        '{"id":"01912345-6789-7abc-8def-0123456789ab","text":"Pago mensual de arriendo en Bogotá"}',
        32,
      ],
    ] as const;

    for (const [text, expected] of samples) {
      expect(yield* inference.countMemoryText(text)).toBe(expected);
    }
    expect(yield* Ref.get(transport.requests)).toEqual([]);
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

    yield* inference.prepareText({ ...textRequest(), toolChoice: "none" });
    const disabledCount = (yield* Ref.get(transport.requests))[2];
    if (disabledCount === undefined) return yield* Effect.die("missing disabled count request");
    expect((yield* requestBody(disabledCount)).tool_choice).toBe("none");
  })
);

it.effect("measures and executes the exact strict structured schema, name, and framing", () =>
  Effect.gen(function* () {
    const outputJson = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({
      compactedConversation: "trusted",
      optionalLabel: null,
    });
    const transport = yield* makeTransport(100, makeOpenAiTextResponse(outputJson));
    const inference = yield* buildInference(transport.layer);
    const prepared = yield* inference.prepareStructured(structuredRequest());

    expect(yield* inference.executeStructured(prepared)).toEqual({
      compactedConversation: "trusted",
    });
    const [count, execute] = yield* Ref.get(transport.requests);
    if (count === undefined || execute === undefined) return yield* Effect.die("missing requests");
    const countJson = yield* requestBody(count);
    const executeJson = yield* requestBody(execute);
    expect(countJson.text).toEqual(executeJson.text);
    expect(countJson.text).toMatchObject({
      format: {
        type: "json_schema",
        name: "compacted_conversation",
        strict: true,
      },
    });
    expect(countJson.input).toEqual(executeJson.input);
    expect(countJson.reasoning).toEqual(executeJson.reasoning);
    expect(countJson.truncation).toEqual(executeJson.truncation);
    expect(executeJson.tools).toEqual([]);
    expect(executeJson.max_output_tokens).toBe(16_000);
  })
);

it.effect("returns typed structured failures without retaining hostile model text", () =>
  Effect.gen(function* () {
    const canary = "HOSTILE_PRIVATE_MODEL_BODY";
    const outputJson = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)({
      compactedConversation: canary,
      optionalLabel: 42,
    });
    const transport = yield* makeTransport(100, makeOpenAiTextResponse(outputJson));
    const inference = yield* buildInference(transport.layer);
    const prepared = yield* inference.prepareStructured(structuredRequest());

    const failure = yield* inference.executeStructured(prepared).pipe(Effect.flip);
    expect(failure.reason).toEqual({
      _tag: "InvalidOutput",
      description: "Hosted structured output was malformed",
    });
    expect(String(failure)).not.toContain(canary);
    expect(Exit.isFailure(yield* Effect.exit(inference.executeStructured(prepared)))).toBe(true);
  })
);

it.effect("bounds structured provider responses before decoding", () =>
  Effect.gen(function* () {
    for (const transport of [
      yield* makeTransport(100, "x".repeat(1_000_001)),
      yield* makeTransport(100, "small", { "content-length": "1000001" }),
    ]) {
      const inference = yield* buildInference(transport.layer);
      const prepared = yield* inference.prepareStructured(structuredRequest());

      const failure = yield* inference.executeStructured(prepared).pipe(Effect.flip);
      expect(failure.reason).toEqual({ _tag: "StructuredOutputExceeded" });
    }
  })
);

it.effect("rejects structured capacity overflow before execution", () =>
  Effect.gen(function* () {
    const transport = yield* makeTransport(1_034_001);
    const inference = yield* buildInference(transport.layer);

    const failure = yield* inference.prepareStructured(structuredRequest()).pipe(Effect.flip);

    expect(failure.reason).toEqual({ _tag: "CapacityExceeded", inputTokens: 1_034_001 });
    expect(yield* Ref.get(transport.requests)).toHaveLength(1);
  })
);

it.effect("bounds structured token-count responses before execution", () =>
  Effect.gen(function* () {
    const requests = yield* Ref.make(0);
    const client = HttpClient.make((request) =>
      Ref.update(requests, (count) => count + 1).pipe(
        Effect.as(
          HttpClientResponse.fromWeb(
            request,
            new Response("small", {
              status: 200,
              headers: { "content-length": "1000001" },
            })
          )
        )
      )
    );
    const inference = yield* buildInference(Layer.succeed(HttpClient.HttpClient, client));

    const failure = yield* inference.prepareStructured(structuredRequest()).pipe(Effect.flip);

    expect(failure.reason).toEqual({ _tag: "StructuredOutputExceeded" });
    expect(yield* Ref.get(requests)).toBe(1);
  })
);

it.effect("times out structured token counting before execution", () =>
  Effect.gen(function* () {
    const countingStarted = yield* Deferred.make<void>();
    const requests = yield* Ref.make(0);
    const client = HttpClient.make(() =>
      Ref.update(requests, (count) => count + 1).pipe(
        Effect.andThen(Deferred.succeed(countingStarted, undefined)),
        Effect.andThen(Effect.never)
      )
    );
    const inference = yield* buildInference(
      Layer.succeed(HttpClient.HttpClient, client),
      makeOpenAiHarness("2 seconds")
    );
    const fiber = yield* Effect.exit(inference.prepareStructured(structuredRequest())).pipe(
      Effect.forkChild({ startImmediately: true })
    );
    yield* Deferred.await(countingStarted);
    yield* TestClock.adjust("3 seconds");

    const exit = yield* Fiber.join(fiber);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(
        exit.cause.reasons.some(
          (reason) =>
            reason._tag === "Fail" && reason.error.reason._tag === "StructuredOutputTimedOut"
        )
      ).toBe(true);
    }
    expect(yield* Ref.get(requests)).toBe(1);
  })
);

it.effect("times out structured execution at the adapter-owned deadline", () =>
  Effect.gen(function* () {
    const executionStarted = yield* Deferred.make<void>();
    const client = HttpClient.make((request) =>
      request.url.includes("/responses/input_tokens")
        ? Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response('{"object":"response.input_tokens","input_tokens":100}', {
                status: 200,
                headers: { "content-type": "application/json" },
              })
            )
          )
        : Deferred.succeed(executionStarted, undefined).pipe(Effect.andThen(Effect.never))
    );
    const inference = yield* buildInference(
      Layer.succeed(HttpClient.HttpClient, client),
      makeOpenAiHarness("2 seconds")
    );
    const prepared = yield* inference.prepareStructured(structuredRequest());
    const fiber = yield* Effect.exit(inference.executeStructured(prepared)).pipe(
      Effect.forkChild({ startImmediately: true })
    );
    yield* Deferred.await(executionStarted);
    yield* TestClock.adjust("3 seconds");

    const exit = yield* Fiber.join(fiber);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(
        exit.cause.reasons.some(
          (reason) =>
            reason._tag === "Fail" && reason.error.reason._tag === "StructuredOutputTimedOut"
        )
      ).toBe(true);
    }
    expect(Exit.isFailure(yield* Effect.exit(inference.executeStructured(prepared)))).toBe(true);
  })
);

it.effect("preserves an exact structured request only for retryable provider failure", () =>
  Effect.gen(function* () {
    const canary = "HOSTILE_PROVIDER_FAILURE_BODY";
    const inference = yield* buildInference(makeExecutionFailingTransport(500, canary));
    const prepared = yield* inference.prepareStructured(structuredRequest());

    const first = yield* inference.executeStructured(prepared).pipe(Effect.flip);
    const second = yield* inference.executeStructured(prepared).pipe(Effect.flip);
    expect(first.reason._tag).toBe("ProviderUnavailable");
    expect(first.retryable).toBe(true);
    expect(second.reason._tag).toBe("ProviderUnavailable");
    expect(String(first)).not.toContain(canary);
  })
);

it.effect(
  "consumes structured authority after malformed envelopes and terminal provider failure",
  () =>
    Effect.gen(function* () {
      for (const transportLayer of [
        (yield* makeTransport(100, "{}")).layer,
        makeExecutionFailingTransport(400, "HOSTILE_TERMINAL_BODY"),
      ]) {
        const inference = yield* buildInference(transportLayer);
        const prepared = yield* inference.prepareStructured(structuredRequest());
        const failure = yield* inference.executeStructured(prepared).pipe(Effect.flip);
        expect(["InvalidOutput", "ProviderUnavailable"]).toContain(failure.reason._tag);
        expect(Exit.isFailure(yield* Effect.exit(inference.executeStructured(prepared)))).toBe(
          true
        );
        expect(String(failure)).not.toContain("HOSTILE_TERMINAL_BODY");
      }
    })
);

it.effect("rejects unsupported structured schemas before provider I/O", () =>
  Effect.gen(function* () {
    const transport = yield* makeTransport(100);
    const inference = yield* buildInference(transport.layer);
    const failure = yield* inference
      .prepareStructured({
        ...structuredRequest(),
        outputSchema: Schema.Struct({ unsupported: Schema.Unknown }),
      })
      .pipe(Effect.flip);

    expect(failure.reason).toEqual({
      _tag: "InvalidOutput",
      description: "Hosted structured schema was invalid",
    });
    expect(yield* Ref.get(transport.requests)).toHaveLength(0);
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

it.effect("projects replayed Assistant text and tool outcomes as Responses input", () =>
  Effect.gen(function* () {
    const transport = yield* makeTransport(100);
    const inference = yield* buildInference(transport.layer);
    const request: HostedTextRequest = {
      ...textRequest(),
      context: makeHostedTextContext({
        prefix: [
          { role: "assistant", content: "prior answer" },
          { role: "assistant", content: [{ type: "text", text: "another answer" }] },
          {
            role: "assistant",
            content: [
              {
                type: "tool-call",
                id: "prior_call",
                name: agentOperationBindings[0]?.wireName ?? "identity__getCurrentUser",
                params: {},
              },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                id: "prior_call",
                name: agentOperationBindings[0]?.wireName ?? "identity__getCurrentUser",
                result: { status: "completed" },
                isFailure: false,
              },
            ],
          },
        ],
        continuationTail: [],
        suffix: [{ role: "user", content: [{ type: "text", text: "continue" }] }],
      }),
    };

    yield* inference.prepareText(request);
    const [count] = yield* Ref.get(transport.requests);
    if (count === undefined) return yield* Effect.die("missing count request");
    const input = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(
      (yield* requestBody(count)).input
    );
    expect(input).toContain('"role":"assistant"');
    expect(input).toContain('"type":"input_text"');
    expect(input).toContain('"type":"function_call"');
    expect(input).toContain('"type":"function_call_output"');
  })
);

it.effect("rejects unsupported semantic Prompt parts before counting", () =>
  Effect.gen(function* () {
    const unsupportedMessages = [
      {
        role: "user",
        content: [{ type: "file", mediaType: "image/png", data: "aW1hZ2U=" }],
      },
      { role: "assistant", content: [{ type: "reasoning", text: "private reasoning" }] },
      {
        role: "tool",
        content: [{ type: "tool-approval-response", approvalId: "approval", approved: false }],
      },
    ] as const;

    for (const message of unsupportedMessages) {
      const transport = yield* makeTransport(100);
      const inference = yield* buildInference(transport.layer);
      const failure = yield* inference
        .prepareText({
          ...textRequest(),
          context: makeHostedTextContext({
            prefix: [message],
            continuationTail: [],
            suffix: [],
          }),
        })
        .pipe(Effect.flip);
      expect(failure.reason).toEqual({
        _tag: "InvalidOutput",
        description: "Semantic hosted text projection was invalid",
      });
      expect(yield* Ref.get(transport.requests)).toHaveLength(0);
    }
  })
);

it.effect("maps OpenAI completion reasons and cached usage", () =>
  Effect.gen(function* () {
    const usage = {
      input_tokens: 20,
      input_tokens_details: { cached_tokens: 7 },
      output_tokens: 3,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 23,
    };
    const usageWithoutDetails = {
      input_tokens: 20,
      output_tokens: 3,
      output_tokens_details: { reasoning_tokens: 0 },
      total_tokens: 23,
    };
    const cases = [
      {
        status: "incomplete",
        incompleteDetails: { reason: "max_output_tokens" },
        expected: "length",
        responseUsage: usage,
      },
      {
        status: "incomplete",
        incompleteDetails: { reason: "content_filter" },
        expected: "error",
        responseUsage: usage,
      },
      {
        status: "completed",
        incompleteDetails: null,
        expected: "stop",
        responseUsage: null,
      },
      {
        status: "completed",
        incompleteDetails: null,
        expected: "stop",
        responseUsage: usageWithoutDetails,
      },
    ] as const;

    for (const { expected, incompleteDetails, responseUsage, status } of cases) {
      const response = amendResponse(makeOpenAiTextResponse("partial"), {
        status,
        incomplete_details: incompleteDetails,
        usage: responseUsage,
      });
      const transport = yield* makeTransport(100, response);
      const inference = yield* buildInference(transport.layer);
      const result = yield* inference
        .prepareText(textRequest())
        .pipe(Effect.flatMap(inference.executeText));
      expect(result.finishReason).toBe(expected);
      expect(result.usage).toEqual(
        responseUsage === null
          ? { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 }
          : {
              inputTokens: 20,
              outputTokens: 3,
              cachedInputTokens: "input_tokens_details" in responseUsage ? 7 : 0,
            }
      );
    }
  })
);

it.effect("classifies retryable and terminal OpenAI HTTP failures", () =>
  Effect.gen(function* () {
    for (const [status, retryable] of [
      [408, true],
      [409, true],
      [429, true],
      [500, true],
      [400, false],
    ] as const) {
      const inference = yield* buildInference(makeFailingTransport(status));
      const failure = yield* inference.prepareText(textRequest()).pipe(Effect.flip);
      expect(failure.reason._tag).toBe("ProviderUnavailable");
      expect(failure.retryable).toBe(retryable);
    }
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
