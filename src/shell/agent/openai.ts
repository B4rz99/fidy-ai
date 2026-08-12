import { OpenAiClient, OpenAiLanguageModel, OpenAiSchema } from "@effect/ai-openai";
import * as Generated from "@effect/ai-openai/Generated";
import {
  Config,
  type Duration,
  Effect,
  type JsonSchema,
  Layer,
  Option,
  Schema,
  Stream,
} from "effect";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";
import type { ConfigError } from "effect/Config";
import { type Prompt, Tool } from "effect/unstable/ai";
import { toCodecOpenAI } from "effect/unstable/ai/OpenAiStructuredOutput";
import {
  HttpBody,
  type HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";
import {
  HostedInference,
  type HostedInferenceAdapter,
  HostedInferenceError,
  type HostedInferenceService,
  type HostedInvalidOutputDescription,
  type HostedStructuredAdapter,
  type HostedTextProjection,
  type HostedTextResult,
  HostedToolCallMaximum,
  makeHostedInference,
  makeHostedTextContext,
} from "./hosted-inference";
import { agentOperationBindings, agentOperationToolDescription } from "./toolkit";

/** Direct launch model for Fidy's agent; model selection is not runtime-configurable. */
export const FidyAgentModel = "gpt-5.6-luna";

const hostedContextCapacity = 1_050_000;
const hostedOutputTokenReserve = 16_000;
// Matches the existing maximum bounded canonical evidence contract; this is decimal bytes, not MiB.
const maximumStructuredResponseBytes = 1_000_000;
const structuredExecutionTimeout = "30 seconds";

type StructuredExecutionPolicy = Readonly<{
  timeout: Duration.Input;
}>;

const productionStructuredExecutionPolicy: StructuredExecutionPolicy = {
  timeout: structuredExecutionTimeout,
};
const startupMaximumTranscriptCharacters = 32_000;
const startupMaximumToolCalls = 12;

/** Fixed generation controls for predictable low-latency hosted turns. */
export const HostedAgentGenerationConfig = {
  temperature: 0.7,
  reasoning: { effort: "none" },
  parallel_tool_calls: false,
  store: false,
} as const;

/** Testing bridge for legacy deterministic LanguageModel fixtures. */
type HostedToolCallCapOverride = <A, E, R>(
  effect: Effect.Effect<A, E, R>
) => Effect.Effect<A, E, Exclude<R, OpenAiLanguageModel.Config>>;

export const withHostedToolCallCap = (maximum: HostedToolCallMaximum): HostedToolCallCapOverride =>
  OpenAiLanguageModel.withConfigOverride({ max_tool_calls: maximum });

const OpenAiClientLive = OpenAiClient.layerConfig({
  apiKey: Config.redacted("OPENAI_API_KEY"),
  apiUrl: Config.string("OPENAI_API_URL").pipe(Config.withDefault("https://api.openai.com/v1")),
});

type OpenAiTool = Readonly<{
  type: "function";
  name: string;
  description: string;
  parameters: (typeof agentOperationBindings)[number]["wireJsonSchema"];
  strict: true;
}>;

type OpenAiCountedRequest = Readonly<{
  model: string;
  input: ReadonlyArray<OpenAiSchema.InputItem>;
  reasoning: typeof HostedAgentGenerationConfig.reasoning;
  parallel_tool_calls: false;
  text: Readonly<{ format: Readonly<{ type: "text" }> }>;
  truncation: "disabled";
  tools: ReadonlyArray<OpenAiTool>;
}> &
  (Readonly<{ tool_choice: "none" }> | Readonly<{ tool_choice: "auto" }>);

type OpenAiRequest = OpenAiCountedRequest &
  Readonly<{
    temperature: number;
    store: false;
    include: readonly ["reasoning.encrypted_content"];
    max_output_tokens: number;
  }> &
  (Readonly<{ tool_choice: "none" }> | Readonly<{ tool_choice: "auto"; max_tool_calls: number }>);

type OpenAiStructuredFormat = Readonly<{
  type: "json_schema";
  name: string;
  schema: JsonSchema.JsonSchema;
  strict: true;
}>;

type OpenAiStructuredCountedRequest = Readonly<{
  model: string;
  input: ReadonlyArray<OpenAiSchema.InputItem>;
  reasoning: typeof HostedAgentGenerationConfig.reasoning;
  parallel_tool_calls: false;
  text: Readonly<{ format: OpenAiStructuredFormat }>;
  truncation: "disabled";
  tools: readonly [];
  tool_choice: "none";
}>;

type OpenAiStructuredRequest = OpenAiStructuredCountedRequest &
  Readonly<{
    temperature: number;
    store: false;
    max_output_tokens: number;
  }>;

type OpenAiContinuation = ReadonlyArray<unknown>;
type PreparedOpenAiRequest = Readonly<{
  wire: OpenAiRequest;
  continuationPrefix: OpenAiContinuation;
}>;

const providerStatus = (cause: unknown): Option.Option<number> =>
  Option.liftPredicate(
    typeof cause === "object" &&
      cause !== null &&
      "response" in cause &&
      typeof cause.response === "object" &&
      cause.response !== null &&
      "status" in cause.response
      ? cause.response.status
      : null,
    (status): status is number => typeof status === "number"
  );

const providerUnavailable = (
  retryable = false,
  retryAfter: Option.Option<Duration.Duration> = Option.none()
): HostedInferenceError =>
  new HostedInferenceError({
    reason: { _tag: "ProviderUnavailable" },
    retryable,
    retryAfter,
  });

const requestTimeoutStatus = 408;
const conflictStatus = 409;
const rateLimitedStatus = 429;
const minimumServerFailureStatus = 500;
const retryableProviderStatuses = new Set([
  requestTimeoutStatus,
  conflictStatus,
  rateLimitedStatus,
]);

const countFailure = (cause: unknown): HostedInferenceError =>
  providerUnavailable(
    Option.exists(
      providerStatus(cause),
      (status) => retryableProviderStatuses.has(status) || status >= minimumServerFailureStatus
    )
  );

const invalidProviderOutput = (description: HostedInvalidOutputDescription): HostedInferenceError =>
  new HostedInferenceError({
    reason: { _tag: "InvalidOutput", description },
    retryable: false,
    retryAfter: Option.none(),
  });

const promptParts = (
  content: string | ReadonlyArray<Prompt.PartEncoded>
): ReadonlyArray<Prompt.PartEncoded> =>
  typeof content === "string" ? [{ type: "text", text: content }] : content;

const projectAssistant = (message: Prompt.AssistantMessageEncoded): ReadonlyArray<unknown> =>
  promptParts(message.content).flatMap((part): ReadonlyArray<unknown> => {
    if (part.type === "text") {
      return [
        {
          role: "assistant",
          content: [{ type: "input_text", text: part.text }],
        },
      ];
    }
    if (part.type === "tool-call") {
      return [
        {
          type: "function_call",
          name: part.name,
          call_id: part.id,
          arguments: JSON.stringify(part.params),
          status: "completed",
        },
      ];
    }
    throw new Error("Hosted text context contains unsupported Assistant content");
  });

const projectTool = (message: Prompt.ToolMessageEncoded): ReadonlyArray<unknown> =>
  message.content.map((part) => {
    if (part.type !== "tool-result") {
      throw new Error("Hosted text context contains unsupported tool content");
    }
    return {
      type: "function_call_output",
      call_id: part.id,
      output: JSON.stringify(part.result),
      status: "completed",
    };
  });

const projectMessage = (message: Prompt.MessageEncoded): ReadonlyArray<unknown> => {
  switch (message.role) {
    case "system":
      return [{ role: "developer", content: message.content }];
    case "user":
      return [
        {
          role: "user",
          content: promptParts(message.content).map((part) => {
            if (part.type !== "text") {
              throw new Error("Hosted text context contains unsupported User media");
            }
            return { type: "input_text", text: part.text };
          }),
        },
      ];
    case "assistant":
      return projectAssistant(message);
    case "tool":
      return projectTool(message);
  }
};

type ProjectedOpenAiInput = Readonly<{
  input: ReadonlyArray<OpenAiSchema.InputItem>;
  continuationPrefix: OpenAiContinuation;
}>;

const projectMessages = (
  projection: HostedTextProjection,
  continuation: Option.Option<OpenAiContinuation>
): Effect.Effect<ProjectedOpenAiInput, HostedInferenceError> =>
  Effect.try({
    try: () => {
      const prefix = projection.prefix.flatMap(projectMessage);
      const prior = Option.getOrElse(continuation, () => []);
      const tail = projection.continuationTail.flatMap(projectMessage);
      return {
        input: [...prefix, ...prior, ...tail, ...projection.suffix.flatMap(projectMessage)],
        continuationStart: prefix.length,
        continuationEnd: prefix.length + prior.length + tail.length,
      };
    },
    catch: () => invalidProviderOutput("Semantic hosted text projection was invalid"),
  }).pipe(
    Effect.flatMap(({ continuationEnd, continuationStart, input }) =>
      Schema.decodeUnknownEffect(Schema.Array(OpenAiSchema.InputItem))(input).pipe(
        Effect.map((decoded) => ({
          input: decoded,
          continuationPrefix: decoded.slice(continuationStart, continuationEnd),
        }))
      )
    ),
    Effect.mapError((error) =>
      error._tag === "HostedInferenceError"
        ? error
        : invalidProviderOutput("Semantic hosted text projection was invalid")
    )
  );

const completeCanonicalTools: ReadonlyArray<OpenAiTool> = agentOperationBindings.map((binding) => ({
  type: "function" as const,
  name: binding.wireName,
  description: agentOperationToolDescription(binding),
  parameters: binding.wireJsonSchema,
  strict: true,
}));

const makeCountedRequest = (
  input: ReadonlyArray<OpenAiSchema.InputItem>,
  toolChoice: "auto" | "none"
): OpenAiCountedRequest => {
  const framing = {
    model: FidyAgentModel,
    input,
    reasoning: HostedAgentGenerationConfig.reasoning,
    parallel_tool_calls: HostedAgentGenerationConfig.parallel_tool_calls,
    text: { format: { type: "text" as const } },
    truncation: "disabled" as const,
  };
  return toolChoice === "none"
    ? { ...framing, tool_choice: toolChoice, tools: completeCanonicalTools }
    : { ...framing, tool_choice: toolChoice, tools: completeCanonicalTools };
};

const makeExecutionRequest = (
  countedRequest: OpenAiCountedRequest,
  maximumToolCalls: number
): OpenAiRequest => {
  const controls = {
    temperature: HostedAgentGenerationConfig.temperature,
    store: HostedAgentGenerationConfig.store,
    include: ["reasoning.encrypted_content"] as const,
    max_output_tokens: hostedOutputTokenReserve,
  };
  return countedRequest.tool_choice === "none"
    ? { ...countedRequest, ...controls }
    : { ...countedRequest, ...controls, max_tool_calls: maximumToolCalls };
};

const requestInputTokenCount = (
  client: OpenAiClient.Service,
  request: OpenAiCountedRequest | OpenAiStructuredCountedRequest
): Effect.Effect<HttpClientResponse.HttpClientResponse, HostedInferenceError> =>
  client.client
    .execute(
      HttpClientRequest.post("/responses/input_tokens", {
        body: HttpBody.jsonUnsafe(request),
      })
    )
    .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk), Effect.mapError(countFailure));

const countInputTokens = (
  client: OpenAiClient.Service,
  request: OpenAiCountedRequest | OpenAiStructuredCountedRequest
): Effect.Effect<number, HostedInferenceError> =>
  requestInputTokenCount(client, request).pipe(
    Effect.flatMap((response) =>
      HttpClientResponse.schemaBodyJson(Generated.TokenCountsResource)(response).pipe(
        Effect.mapError(() => invalidProviderOutput("Hosted provider response was invalid"))
      )
    ),
    Effect.map(({ input_tokens }) => input_tokens)
  );

const incompleteFinishReasons = new Map<unknown, HostedTextResult["finishReason"]>([
  ["max_output_tokens", "length"],
  ["content_filter", "error"],
]);

const finishReason = (
  response: OpenAiSchema.Response,
  hasToolCalls: boolean
): HostedTextResult["finishReason"] => {
  if (hasToolCalls) return "tool-calls";
  return Option.fromNullishOr(response.incomplete_details).pipe(
    Option.map((details) => details.reason),
    Option.flatMap((reason) => Option.fromNullishOr(incompleteFinishReasons.get(reason))),
    Option.getOrElse((): HostedTextResult["finishReason"] => "stop")
  );
};

const cachedInputTokens = (usage: OpenAiSchema.Response["usage"]): number => {
  if (usage === undefined || usage === null) return 0;
  const details = usage.input_tokens_details;
  if (typeof details !== "object" || details === null || !("cached_tokens" in details)) return 0;
  return typeof details.cached_tokens === "number" ? details.cached_tokens : 0;
};

type FunctionCallItem = Extract<
  OpenAiSchema.Response["output"][number],
  { readonly type: "function_call" }
>;

const decodeToolCall = (
  item: FunctionCallItem
): Effect.Effect<HostedTextResult["toolCalls"][number], HostedInferenceError> =>
  Effect.try({
    try: () => ({
      id: item.call_id,
      name: item.name,
      params: Tool.unsafeSecureJsonParse(item.arguments),
    }),
    catch: () => invalidProviderOutput("Hosted tool arguments were invalid"),
  });

const outputText = (response: OpenAiSchema.Response): ReadonlyArray<string> =>
  response.output.flatMap((item) =>
    item.type === "message"
      ? item.content.flatMap((content) => (content.type === "output_text" ? [content.text] : []))
      : []
  );

const decodeResult = (
  response: OpenAiSchema.Response
): Effect.Effect<Omit<HostedTextResult, "continuation">, HostedInferenceError> =>
  Effect.gen(function* () {
    const text = outputText(response);
    const toolCalls = yield* Effect.forEach(
      response.output.filter((item): item is FunctionCallItem => item.type === "function_call"),
      decodeToolCall
    );
    return {
      text: text.join(""),
      toolCalls,
      finishReason: finishReason(response, toolCalls.length > 0),
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
        cachedInputTokens: cachedInputTokens(response.usage),
      },
    };
  });

const executeRequest = (
  client: OpenAiClient.Service,
  request: OpenAiRequest
): Effect.Effect<OpenAiSchema.Response, HostedInferenceError> =>
  client.client
    .execute(
      HttpClientRequest.post("/responses", {
        body: HttpBody.jsonUnsafe(request),
      })
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError(countFailure),
      Effect.flatMap((response) =>
        HttpClientResponse.schemaBodyJson(OpenAiSchema.Response)(response).pipe(
          Effect.mapError(() => invalidProviderOutput("Hosted provider response was invalid"))
        )
      )
    );

const memoryTokenizer = new Tiktoken(o200kBase);

type BoundedBody = Readonly<{ chunks: ReadonlyArray<Uint8Array>; size: number }>;

const structuredOutputExceeded = (): HostedInferenceError =>
  new HostedInferenceError({
    reason: { _tag: "StructuredOutputExceeded" },
    retryable: false,
    retryAfter: Option.none(),
  });

const structuredOutputTimedOut = (): HostedInferenceError =>
  new HostedInferenceError({
    reason: { _tag: "StructuredOutputTimedOut" },
    retryable: false,
    retryAfter: Option.none(),
  });

const readBoundedResponseText = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<string, HostedInferenceError> => {
  const declaredLength = Number(response.headers["content-length"] ?? 0);
  if (declaredLength > maximumStructuredResponseBytes) {
    return Effect.fail(structuredOutputExceeded());
  }
  return Stream.runFoldEffect(
    response.stream,
    (): BoundedBody => ({ chunks: [], size: 0 }),
    (body, chunk) =>
      body.size + chunk.byteLength > maximumStructuredResponseBytes
        ? Effect.fail(structuredOutputExceeded())
        : Effect.succeed({
            chunks: [...body.chunks, chunk],
            size: body.size + chunk.byteLength,
          })
  ).pipe(
    Effect.mapError((error) =>
      error instanceof HostedInferenceError ? error : providerUnavailable()
    ),
    Effect.map((body) => {
      const bytes = new Uint8Array(body.size);
      let offset = 0;
      for (const chunk of body.chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return new TextDecoder().decode(bytes);
    })
  );
};

const countStructuredInputTokens = (
  client: OpenAiClient.Service,
  request: OpenAiStructuredCountedRequest,
  policy: StructuredExecutionPolicy
): Effect.Effect<number, HostedInferenceError> =>
  requestInputTokenCount(client, request).pipe(
    Effect.flatMap(readBoundedResponseText),
    Effect.flatMap(
      Schema.decodeUnknownEffect(Schema.fromJsonString(Generated.TokenCountsResource))
    ),
    Effect.map(({ input_tokens }) => input_tokens),
    Effect.mapError((error) =>
      error instanceof HostedInferenceError
        ? error
        : invalidProviderOutput("Hosted provider response was invalid")
    ),
    Effect.timeout(policy.timeout),
    Effect.catchTag("TimeoutError", () => Effect.fail(structuredOutputTimedOut()))
  );

const readStructuredResponse = (
  response: HttpClientResponse.HttpClientResponse
): Effect.Effect<OpenAiSchema.Response, HostedInferenceError> =>
  readBoundedResponseText(response).pipe(
    Effect.flatMap((body) =>
      Schema.decodeUnknownEffect(Schema.fromJsonString(OpenAiSchema.Response))(body).pipe(
        Effect.mapError(() =>
          invalidProviderOutput("Hosted structured provider response was invalid")
        )
      )
    )
  );

const structuredText = (response: OpenAiSchema.Response): string => outputText(response).join("");

const makeStructuredCountedRequest = (
  input: ReadonlyArray<OpenAiSchema.InputItem>,
  format: OpenAiStructuredFormat
): OpenAiStructuredCountedRequest => ({
  model: FidyAgentModel,
  input,
  reasoning: HostedAgentGenerationConfig.reasoning,
  parallel_tool_calls: false,
  text: { format },
  truncation: "disabled",
  tools: [],
  tool_choice: "none",
});

/**
 * This transport seam deliberately emits no telemetry: it has no actor or operation identity with
 * which to create a bounded envelope. The owning workflow records attempts, latency, failures, and
 * model usage once structured generation is integrated by #206.
 */
const executeStructuredRequest = <Output>(
  client: OpenAiClient.Service,
  prepared: Readonly<{
    request: OpenAiStructuredRequest;
    codec: Schema.ConstraintCodec<Output, unknown>;
    policy: StructuredExecutionPolicy;
  }>
): Effect.Effect<Output, HostedInferenceError> =>
  client.client
    .execute(
      HttpClientRequest.post("/responses", {
        body: HttpBody.jsonUnsafe(prepared.request),
      })
    )
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError(countFailure),
      Effect.flatMap(readStructuredResponse),
      Effect.flatMap((response) =>
        Schema.decodeUnknownEffect(Schema.fromJsonString(prepared.codec))(
          structuredText(response)
        ).pipe(
          Effect.mapError(() => invalidProviderOutput("Hosted structured output was malformed"))
        )
      ),
      Effect.timeout(prepared.policy.timeout),
      Effect.catchTag("TimeoutError", () => Effect.fail(structuredOutputTimedOut()))
    );

const makeStructuredAdapter = (
  client: OpenAiClient.Service,
  policy: StructuredExecutionPolicy
): HostedStructuredAdapter => ({
  prepare: (input) =>
    Effect.gen(function* () {
      const projected = yield* projectMessages(
        { prefix: input.projection.messages, continuationTail: [], suffix: [] },
        Option.none()
      );
      const transformed = yield* Effect.try({
        try: () => toCodecOpenAI(input.outputSchema),
        catch: () => invalidProviderOutput("Hosted structured schema was invalid"),
      });
      const format: OpenAiStructuredFormat = {
        type: "json_schema",
        name: input.objectName,
        schema: transformed.jsonSchema,
        strict: true,
      };
      const counted = makeStructuredCountedRequest(projected.input, format);
      const inputTokens = yield* countStructuredInputTokens(client, counted, policy);
      if (inputTokens + hostedOutputTokenReserve > hostedContextCapacity) {
        return yield* new HostedInferenceError({
          reason: { _tag: "CapacityExceeded", inputTokens },
          retryable: false,
          retryAfter: Option.none(),
        });
      }
      const request: OpenAiStructuredRequest = {
        ...counted,
        temperature: HostedAgentGenerationConfig.temperature,
        store: false,
        max_output_tokens: hostedOutputTokenReserve,
      };
      return {
        execute: executeStructuredRequest(client, {
          request,
          codec: transformed.codec,
          policy,
        }),
      };
    }),
});

const makeOpenAiHostedInference = (
  client: OpenAiClient.Service,
  structuredPolicy: StructuredExecutionPolicy
): HostedInferenceService => {
  const adapter: HostedInferenceAdapter<PreparedOpenAiRequest, OpenAiContinuation> = {
    countMemoryText: (text) => Effect.sync(() => memoryTokenizer.encode(text).length),
    prepare: (semanticInput) =>
      Effect.gen(function* () {
        const projected = yield* projectMessages(
          semanticInput.projection,
          semanticInput.continuation
        );
        const countedRequest = makeCountedRequest(projected.input, semanticInput.toolChoice);
        const request = makeExecutionRequest(
          countedRequest,
          semanticInput.toolChoice === "none" ? 0 : semanticInput.maximumToolCalls
        );
        const inputTokens = yield* countInputTokens(client, countedRequest);
        if (inputTokens + hostedOutputTokenReserve > hostedContextCapacity) {
          return yield* new HostedInferenceError({
            reason: { _tag: "CapacityExceeded", inputTokens },
            retryable: false,
            retryAfter: Option.none(),
          });
        }
        return { wire: request, continuationPrefix: projected.continuationPrefix };
      }),
    structured: makeStructuredAdapter(client, structuredPolicy),
    execute: (request) =>
      executeRequest(client, request.wire).pipe(
        Effect.flatMap((response) =>
          Effect.map(decodeResult(response), (result) => ({
            result,
            continuation: [...request.continuationPrefix, ...response.output],
          }))
        )
      ),
  };
  return makeHostedInference(adapter);
};

const startupContext = (): ReturnType<typeof makeHostedTextContext> =>
  makeHostedTextContext({
    prefix: [
      {
        role: "system",
        content: "x".repeat(startupMaximumTranscriptCharacters),
      },
    ],
    continuationTail: [],
    suffix: [{ role: "system", content: "maximum hosted turn framing" }],
  });

const makeOpenAiLayer = (
  validateStartup: boolean,
  structuredPolicy: StructuredExecutionPolicy
): Layer.Layer<HostedInference, ConfigError | HostedInferenceError, HttpClient.HttpClient> =>
  Layer.effect(
    HostedInference,
    Effect.gen(function* () {
      const client = yield* OpenAiClient.OpenAiClient;
      const inference = makeOpenAiHostedInference(client, structuredPolicy);
      if (validateStartup) {
        yield* inference.validateText({
          context: startupContext(),
          continuation: Option.none(),
          toolChoice: "auto",
          maximumToolCalls: HostedToolCallMaximum.make(startupMaximumToolCalls),
        });
      }
      return inference;
    })
  ).pipe(Layer.provide(OpenAiClientLive));

/** Production OpenAI adapter with fail-closed maximum-request startup validation. */
export const OpenAiHostedInferenceLive = makeOpenAiLayer(true, productionStructuredExecutionPolicy);

/** Production adapter without startup validation for focused transport tests. */
export const OpenAiHostedInferenceWithoutStartupValidation = makeOpenAiLayer(
  false,
  productionStructuredExecutionPolicy
);

/** Test-only constructor for proving adapter-owned structured execution deadlines. @internal */
export const makeOpenAiHarness = (
  timeout: Duration.Input
): Layer.Layer<HostedInference, ConfigError | HostedInferenceError, HttpClient.HttpClient> =>
  makeOpenAiLayer(false, { timeout });
