import { jsonStringSchema } from "~/schema-compatibility";
import { OpenAiClient, OpenAiLanguageModel, OpenAiSchema } from "@effect/ai-openai";
import * as Generated from "@effect/ai-openai/Generated";
import {
  Config,
  DateTime,
  type Duration,
  Effect,
  type JsonSchema,
  Layer,
  Option,
  Schema,
} from "effect";
import { Tiktoken } from "js-tiktoken/lite";
import o200kBase from "js-tiktoken/ranks/o200k_base";
import type { ConfigError } from "effect/Config";
import { IanaTimeZone } from "~/core/_shared/context";
import {
  type BoundedExternalHttpResponse,
  type ExternalHttpFailure,
  boundedProviderLibraryHttpClientLayer,
  makeBoundedExternalHttpClient,
} from "~/shell/_shared/bounded-external-http";
import { maximumAggregateMemoryTokens } from "~/core/memory/rules";
import {
  defaultCompactionMaximumTokens,
  defaultCompactionTriggerTokens,
} from "~/core/transcript/compaction-policy";
import { type Prompt, Tool } from "effect/unstable/ai";
import { toCodecOpenAI } from "effect/unstable/ai/OpenAiStructuredOutput";
import type { TranscriptEntry } from "~/core/transcript/model";
import { exactTranscriptPrompt } from "./model-boundary";
import { HttpBody, type HttpClient, HttpClientRequest } from "effect/unstable/http";
import {
  HostedInference,
  type HostedInferenceAdapter,
  HostedInferenceError,
  type HostedInferenceService,
  type HostedInvalidOutputDescription,
  type HostedStructuredAdapter,
  type HostedTextContext,
  type HostedTextResult,
  type HostedTextToolPolicy,
  HostedToolCallMaximum,
  makeHostedInference,
  maximumActiveRequestTokens,
} from "./hosted-inference";
import { agentOperationBindings, agentOperationToolDescription } from "./toolkit";
import { type WorkingContext, makeStartupWorkingContext } from "./working-context";

/** Direct launch model for Fidy's agent; model selection is not runtime-configurable. */
export const FidyAgentModel = "gpt-5.6-luna";

const hostedContextCapacity = 1_050_000;
/** Server-owned production output allowance included in every complete capacity decision. */
export const hostedOutputTokenReserve = 16_000;

type ContinuityBudget =
  | "memory"
  | "compactedConversation"
  | "exactTranscript"
  | "activeRequest"
  | "outputReserve";

type ContinuityBudgets = Readonly<Record<ContinuityBudget, number>>;

const productionContinuityBudgets: ContinuityBudgets = Object.freeze({
  memory: maximumAggregateMemoryTokens,
  compactedConversation: defaultCompactionMaximumTokens,
  exactTranscript: defaultCompactionTriggerTokens,
  activeRequest: maximumActiveRequestTokens,
  outputReserve: hostedOutputTokenReserve,
});
// Matches the existing maximum bounded canonical evidence contract; this is decimal bytes, not MiB.
const maximumStructuredResponseBytes = 1_000_000;
const structuredExecutionTimeout = "30 seconds";

type StructuredExecutionPolicy = Readonly<{
  timeout: Duration.Input;
}>;

const productionStructuredExecutionPolicy: StructuredExecutionPolicy = {
  timeout: structuredExecutionTimeout,
};
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

const OpenAiClientBase = OpenAiClient.layerConfig({
  apiKey: Config.redacted("OPENAI_API_KEY"),
  apiUrl: Config.string("OPENAI_API_URL").pipe(Config.withDefault("https://api.openai.com/v1")),
});

const OpenAiClientLive = OpenAiClientBase.pipe(
  Layer.provide(
    boundedProviderLibraryHttpClientLayer({
      provider: "openai",
      maximumResponseBytes: maximumStructuredResponseBytes,
    })
  )
);

/** Structured-output model used by bounded non-agent extraction adapters. */
export const OpenAiLanguageModelLive = OpenAiLanguageModel.layer({
  model: FidyAgentModel,
  config: HostedAgentGenerationConfig,
}).pipe(Layer.provide(OpenAiClientLive));

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

const providerUnavailable = (
  retryable = false,
  retryAfter: Option.Option<Duration.Duration> = Option.none()
): HostedInferenceError =>
  new HostedInferenceError({
    reason: { _tag: "ProviderUnavailable" },
    retryable,
    retryAfter,
  });

const successfulStatusMinimum = 200;
const successfulStatusMaximumExclusive = 300;
const requestTimeoutStatus = 408;
const conflictStatus = 409;
const rateLimitedStatus = 429;
const minimumServerFailureStatus = 500;
const retryableProviderStatuses = new Set([
  requestTimeoutStatus,
  conflictStatus,
  rateLimitedStatus,
]);

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
  basePrefix: ReadonlyArray<Prompt.MessageEncoded>,
  projection: HostedTextContext,
  continuation: Option.Option<OpenAiContinuation>
): Effect.Effect<ProjectedOpenAiInput, HostedInferenceError> =>
  Effect.try({
    try: () => {
      const prefix = [...basePrefix, ...projection.prefix].flatMap(projectMessage);
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

const makeOpenAiTool = (binding: (typeof agentOperationBindings)[number]): OpenAiTool => ({
  type: "function",
  name: binding.wireName,
  description: agentOperationToolDescription(binding),
  parameters: binding.wireJsonSchema,
  strict: true,
});

const allOperationIds = agentOperationBindings.map(({ operation }) => operation);

const toolsFor = (
  availableOperations: HostedTextToolPolicy["availableOperations"]
): ReadonlyArray<OpenAiTool> => {
  const available = new Set(availableOperations);
  return agentOperationBindings
    .filter(({ operation }) => available.has(operation))
    .map(makeOpenAiTool);
};

const makeCountedRequest = (
  input: ReadonlyArray<OpenAiSchema.InputItem>,
  policy: HostedTextToolPolicy
): OpenAiCountedRequest => {
  const framing = {
    model: FidyAgentModel,
    input,
    reasoning: HostedAgentGenerationConfig.reasoning,
    parallel_tool_calls: HostedAgentGenerationConfig.parallel_tool_calls,
    text: { format: { type: "text" as const } },
    truncation: "disabled" as const,
  };
  return {
    ...framing,
    tool_choice: policy.toolChoice,
    tools: toolsFor(policy.availableOperations),
  };
};

const makeExecutionRequest = (
  countedRequest: OpenAiCountedRequest,
  maximumToolCalls: number,
  outputTokenReserve: number
): OpenAiRequest => {
  const controls = {
    temperature: HostedAgentGenerationConfig.temperature,
    store: HostedAgentGenerationConfig.store,
    include: ["reasoning.encrypted_content"] as const,
    max_output_tokens: outputTokenReserve,
  };
  return countedRequest.tool_choice === "none"
    ? { ...countedRequest, ...controls }
    : { ...countedRequest, ...controls, max_tool_calls: maximumToolCalls };
};

const mapOpenAiTransportFailure = (
  failure: HostedInferenceError | ExternalHttpFailure,
  overflowFailure: () => HostedInferenceError
): HostedInferenceError => {
  if (failure instanceof HostedInferenceError) return failure;
  if (failure.reason === "response-too-large") return overflowFailure();
  if (failure.reason === "response-body-failed") return providerUnavailable();
  return providerUnavailable(
    Option.exists(
      failure.responseStatus,
      (status) => retryableProviderStatuses.has(status) || status >= minimumServerFailureStatus
    )
  );
};

const executeBoundedOpenAiRequest = (
  client: OpenAiClient.Service,
  request: HttpClientRequest.HttpClientRequest,
  overflowFailure: () => HostedInferenceError
): Effect.Effect<BoundedExternalHttpResponse, HostedInferenceError> =>
  client.client
    .pipe(makeBoundedExternalHttpClient("openai"))
    .execute(request, maximumStructuredResponseBytes)
    .pipe(
      Effect.filterOrFail(
        (response) =>
          response.status >= successfulStatusMinimum &&
          response.status < successfulStatusMaximumExclusive,
        (response) =>
          providerUnavailable(
            retryableProviderStatuses.has(response.status) ||
              response.status >= minimumServerFailureStatus
          )
      ),
      Effect.mapError((failure) => mapOpenAiTransportFailure(failure, overflowFailure))
    );

const requestInputTokenCount = (
  client: OpenAiClient.Service,
  request: OpenAiCountedRequest | OpenAiStructuredCountedRequest,
  overflowFailure: () => HostedInferenceError
): Effect.Effect<BoundedExternalHttpResponse, HostedInferenceError> =>
  executeBoundedOpenAiRequest(
    client,
    HttpClientRequest.post("/responses/input_tokens", {
      body: HttpBody.jsonUnsafe(request),
    }),
    overflowFailure
  );

const countInputTokens = (
  client: OpenAiClient.Service,
  request: OpenAiCountedRequest | OpenAiStructuredCountedRequest
): Effect.Effect<number, HostedInferenceError> =>
  requestInputTokenCount(client, request, () =>
    invalidProviderOutput("Hosted provider response was invalid")
  ).pipe(
    Effect.flatMap(readBoundedResponseText),
    Effect.flatMap(Schema.decodeUnknownEffect(jsonStringSchema(Generated.TokenCountsResource))),
    Effect.mapError((error) =>
      error instanceof HostedInferenceError
        ? error
        : invalidProviderOutput("Hosted provider response was invalid")
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
  executeBoundedOpenAiRequest(
    client,
    HttpClientRequest.post("/responses", {
      body: HttpBody.jsonUnsafe(request),
    }),
    () => invalidProviderOutput("Hosted provider response was invalid")
  ).pipe(
    Effect.flatMap(readBoundedResponseText),
    Effect.flatMap(Schema.decodeUnknownEffect(jsonStringSchema(OpenAiSchema.Response))),
    Effect.mapError((error) =>
      error instanceof HostedInferenceError
        ? error
        : invalidProviderOutput("Hosted provider response was invalid")
    )
  );

const memoryTokenizer = new Tiktoken(o200kBase);

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
  response: BoundedExternalHttpResponse
): Effect.Effect<string, HostedInferenceError> =>
  Effect.succeed(new TextDecoder().decode(response.body));

const countStructuredInputTokens = (
  client: OpenAiClient.Service,
  request: OpenAiStructuredCountedRequest,
  policy: StructuredExecutionPolicy
): Effect.Effect<number, HostedInferenceError> =>
  requestInputTokenCount(client, request, structuredOutputExceeded).pipe(
    Effect.flatMap(readBoundedResponseText),
    Effect.flatMap(Schema.decodeUnknownEffect(jsonStringSchema(Generated.TokenCountsResource))),
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
  response: BoundedExternalHttpResponse
): Effect.Effect<OpenAiSchema.Response, HostedInferenceError> =>
  readBoundedResponseText(response).pipe(
    Effect.flatMap((body) =>
      Schema.decodeEffect(jsonStringSchema(OpenAiSchema.Response))(body).pipe(
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
const executeStructuredRequest = function <Output>(
  client: OpenAiClient.Service,
  prepared: Readonly<{
    request: OpenAiStructuredRequest;
    codec: Schema.ConstraintCodec<Output, unknown>;
    policy: StructuredExecutionPolicy;
  }>
): Effect.Effect<Output, HostedInferenceError> {
  return executeBoundedOpenAiRequest(
    client,
    HttpClientRequest.post("/responses", {
      body: HttpBody.jsonUnsafe(prepared.request),
    }),
    structuredOutputExceeded
  ).pipe(
    Effect.flatMap(readStructuredResponse),
    Effect.flatMap((response) =>
      Schema.decodeEffect(jsonStringSchema(prepared.codec))(structuredText(response)).pipe(
        Effect.mapError(() => invalidProviderOutput("Hosted structured output was malformed"))
      )
    ),
    Effect.timeout(prepared.policy.timeout),
    Effect.catchTag("TimeoutError", () => Effect.fail(structuredOutputTimedOut()))
  );
};

const makeStructuredAdapter = (
  client: OpenAiClient.Service,
  policy: StructuredExecutionPolicy,
  outputTokenReserve: number
): HostedStructuredAdapter => ({
  prepare: (input) =>
    Effect.gen(function* () {
      const projected = yield* projectMessages(
        [],
        {
          prefix: input.projection.messages,
          continuationTail: [],
          suffix: [],
          activeRequest: { _tag: "Absent" },
        },
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
      if (inputTokens + outputTokenReserve > hostedContextCapacity) {
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
        max_output_tokens: outputTokenReserve,
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

const countTranscriptTokens = (
  client: OpenAiClient.Service,
  entries: ReadonlyArray<TranscriptEntry>
): Effect.Effect<number> =>
  projectMessages(
    [],
    {
      prefix: exactTranscriptPrompt(entries),
      continuationTail: [],
      suffix: [],
      activeRequest: { _tag: "Absent" },
    },
    Option.none()
  ).pipe(
    Effect.flatMap(({ input }) =>
      countInputTokens(
        client,
        makeCountedRequest(input, {
          toolChoice: "none",
          availableOperations: allOperationIds,
        })
      )
    ),
    Effect.orDie
  );

const makeOpenAiHostedInference = (
  client: OpenAiClient.Service,
  structuredPolicy: StructuredExecutionPolicy,
  outputTokenReserve: number
): HostedInferenceService => {
  const adapter: HostedInferenceAdapter<PreparedOpenAiRequest, OpenAiContinuation> = {
    countText: (text) => Effect.sync(() => memoryTokenizer.encode(text).length),
    countTranscript: (entries) => countTranscriptTokens(client, entries),
    prepare: (semanticInput) =>
      Effect.gen(function* () {
        const projected = yield* projectMessages(
          semanticInput.basePrefix,
          semanticInput.projection,
          semanticInput.continuation
        );
        const countedRequest = makeCountedRequest(projected.input, semanticInput);
        const request = makeExecutionRequest(
          countedRequest,
          semanticInput.toolChoice === "none" ? 0 : semanticInput.maximumToolCalls,
          outputTokenReserve
        );
        const inputTokens = yield* countInputTokens(client, countedRequest);
        if (inputTokens + outputTokenReserve > hostedContextCapacity) {
          return yield* new HostedInferenceError({
            reason: { _tag: "CapacityExceeded", inputTokens },
            retryable: false,
            retryAfter: Option.none(),
          });
        }
        return { wire: request, continuationPrefix: projected.continuationPrefix };
      }),
    structured: makeStructuredAdapter(client, structuredPolicy, outputTokenReserve),
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

const startupMemoryChunkCharacters = 1_800;
const startupTranscriptChunkCharacters = 15_000;

const startupMaximumText = (marker: string, maximumTokens: number): string => {
  const candidate = `${marker}\n${"㐀".repeat(maximumTokens)}`;
  return memoryTokenizer.decode(memoryTokenizer.encode(candidate).slice(0, maximumTokens));
};

const startupChunks = (text: string, maximumCharacters: number): ReadonlyArray<string> =>
  Array.from({ length: Math.ceil(text.length / maximumCharacters) }, (_, index) =>
    text.slice(index * maximumCharacters, (index + 1) * maximumCharacters)
  );

const startupContext = (budgets: ContinuityBudgets): Effect.Effect<WorkingContext> => {
  const memory = startupMaximumText(
    `[STARTUP_MAXIMUM_MEMORY:${budgets.memory}_TOKENS]`,
    budgets.memory
  );
  const compactedConversation = startupMaximumText(
    `[STARTUP_MAXIMUM_COMPACTED_CONVERSATION:${budgets.compactedConversation}_TOKENS]`,
    budgets.compactedConversation
  );
  const exactTranscript = startupMaximumText(
    `[STARTUP_MAXIMUM_EXACT_TRANSCRIPT:${budgets.exactTranscript}_TOKENS]`,
    budgets.exactTranscript
  );
  const activeRequest = startupMaximumText(
    `[STARTUP_MAXIMUM_ACTIVE_REQUEST:${budgets.activeRequest}_TOKENS]`,
    budgets.activeRequest
  );
  return makeStartupWorkingContext({
    user: Option.some({
      serviceMarket: "CO",
      locale: "es-CO",
      timeZone: IanaTimeZone.make("America/Bogota"),
    }),
    memories: startupChunks(memory, startupMemoryChunkCharacters).map((text) => ({ text })),
    transcript: startupChunks(exactTranscript, startupTranscriptChunkCharacters).map((text) => ({
      text,
    })),
    compactedConversation: Option.some({ text: compactedConversation }),
    request: { text: activeRequest },
    startedAt: DateTime.makeUnsafe("2000-01-01T00:00:00Z"),
  }).pipe(Effect.orDie);
};

const makeOpenAiLayer = (
  validateStartup: boolean,
  structuredPolicy: StructuredExecutionPolicy,
  budgets: ContinuityBudgets
): Layer.Layer<HostedInference, ConfigError | HostedInferenceError, HttpClient.HttpClient> =>
  Layer.effect(
    HostedInference,
    Effect.gen(function* () {
      const client = yield* OpenAiClient.OpenAiClient;
      const inference = makeOpenAiHostedInference(client, structuredPolicy, budgets.outputReserve);
      if (validateStartup) {
        yield* inference.validateText({
          context: yield* startupContext(budgets),
          toolChoice: "auto",
          maximumToolCalls: HostedToolCallMaximum.make(startupMaximumToolCalls),
          availableOperations: allOperationIds,
        });
      }
      return inference;
    })
  ).pipe(Layer.provide(OpenAiClientBase));

/** Production OpenAI adapter with fail-closed maximum-request startup validation. */
export const OpenAiHostedInferenceLive = makeOpenAiLayer(
  true,
  productionStructuredExecutionPolicy,
  productionContinuityBudgets
);

/** Production adapter without startup validation for focused transport tests. */
export const OpenAiHostedInferenceWithoutStartupValidation = makeOpenAiLayer(
  false,
  productionStructuredExecutionPolicy,
  productionContinuityBudgets
);

/** Fixed one-budget variation used only to prove independence at the startup seam. @internal */
export const openAiHostedInferenceBudgetVariation = (
  budget: ContinuityBudget
): Layer.Layer<HostedInference, ConfigError | HostedInferenceError, HttpClient.HttpClient> =>
  makeOpenAiLayer(true, productionStructuredExecutionPolicy, {
    ...productionContinuityBudgets,
    [budget]: productionContinuityBudgets[budget] - 1,
  });

/** Test-only constructor for proving adapter-owned structured execution deadlines. @internal */
export const makeOpenAiHarness = (
  timeout: Duration.Input
): Layer.Layer<HostedInference, ConfigError | HostedInferenceError, HttpClient.HttpClient> =>
  makeOpenAiLayer(false, { timeout }, productionContinuityBudgets);
