import { type Duration, Effect, type JsonSchema, Option, Schema } from "effect";
import type { Prompt } from "effect/unstable/ai";
import { Tool } from "effect/unstable/ai";
import type { TranscriptEntry } from "~/core/transcript/model";
import { operationCatalog } from "~/shell/api";
import {
  HostedOperationWireName,
  hostedOperationBindings,
  hostedToolDescription,
} from "~/shell/_shared/hosted-operation-bindings";
import { maximumModelRoundMillis } from "~/shell/_shared/hosted-turn-bounds";
import {
  HostedInferenceError,
  type HostedInferenceService,
  type HostedInvalidOutputDescription,
  type HostedTextResult,
  type HostedTextToolPolicy,
} from "./contract";
import type {
  HostedInferenceAdapter,
  HostedPromptProjection,
  HostedStructuredAdapter,
} from "~/shell/hosted-inference/internal/adapter";
import { makeHostedInferenceInternal } from "~/shell/hosted-inference/internal/inference";
import { hostedOutputTokenReserve } from "~/shell/hosted-inference/internal/limits";
import { exactTranscriptPromptInternal } from "~/shell/hosted-inference/internal/prompt";
import { ApprovedWorkersAiModel } from "./model";

/** Provider input item accepted by the direct binding; callers must use projected content only. */
export type WorkersAiInputItem =
  | Readonly<{ role: "system" | "user"; content: string }>
  | Readonly<{
      role: "assistant";
      content: ReadonlyArray<Readonly<{ type: "input_text"; text: string }>>;
    }>
  | Readonly<{
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string;
      status: "completed";
    }>
  | Readonly<{
      type: "function_call_output";
      call_id: string;
      output: string;
      status: "completed";
    }>;

/** Strict function tool definition derived from one canonical operation schema. */
export type WorkersAiTool = Readonly<{
  type: "function";
  name: string;
  description: string;
  parameters: JsonSchema.JsonSchema;
  strict: true;
}>;

/** Closed direct-binding request shape; gateway routing and provider-side storage are unavailable. */
export type WorkersAiRequest = Readonly<{
  input: ReadonlyArray<WorkersAiInputItem>;
  max_output_tokens: number;
  parallel_tool_calls: false;
  reasoning: Readonly<{ effort: "low" }>;
  text: Readonly<{
    format:
      | Readonly<{ type: "text" }>
      | Readonly<{
          type: "json_schema";
          name: string;
          schema: JsonSchema.JsonSchema;
          strict: true;
        }>;
  }>;
  tool_choice: "none" | "auto";
  tools: ReadonlyArray<WorkersAiTool>;
  truncation: "disabled";
}>;

/** The only Cloudflare capability the portable hosted-inference adapter accepts. */
export type WorkersAiBindingRun = (
  model: ApprovedWorkersAiModel,
  request: WorkersAiRequest,
  options: Readonly<{ returnRawResponse: true; signal: AbortSignal }>
) => Promise<Response>;

type WorkersAiConfiguration = Readonly<{
  model: Option.Option<string>;
  run: Option.Option<WorkersAiBindingRun>;
}>;

type WorkersAiContinuation = ReadonlyArray<WorkersAiInputItem>;
type PreparedWorkersAiRequest = Readonly<{
  continuationPrefix: WorkersAiContinuation;
  maximumToolCalls: number;
  request: WorkersAiRequest;
  visibleOperations: HostedTextToolPolicy["availableOperations"];
}>;

const bytesPerKibibyte = 1024;
const providerResponseMaximumKibibytes = 512;
const providerResponseMaximumBytes = providerResponseMaximumKibibytes * bytesPerKibibyte;
const workersAiContextTokens = 128_000;
const HTTP_OK_MINIMUM = 200;
const HTTP_REDIRECTION_MINIMUM = 300;
const HTTP_REQUEST_TIMEOUT = 408;
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_SERVER_ERROR_MINIMUM = 500;
const structuredExecutionTimeout = "30 seconds";

const providerUnavailable = (retryable: boolean): HostedInferenceError =>
  new HostedInferenceError({
    reason: { _tag: "ProviderUnavailable" },
    retryable,
    retryAfter: Option.none(),
  });

const invalidProviderOutput = (description: HostedInvalidOutputDescription): HostedInferenceError =>
  new HostedInferenceError({
    reason: { _tag: "InvalidOutput", description },
    retryable: false,
    retryAfter: Option.none(),
  });

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

const ProviderResponse = Schema.Struct({
  status: Schema.optionalKey(
    Schema.Literals(["completed", "failed", "in_progress", "cancelled", "queued", "incomplete"])
  ),
  incomplete_details: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({ reason: Schema.optionalKey(Schema.String) }))
  ),
  output: Schema.Array(
    Schema.Union([
      Schema.Struct({
        type: Schema.Literal("message"),
        content: Schema.Array(
          Schema.Union([
            Schema.Struct({ type: Schema.Literal("output_text"), text: Schema.String }),
            Schema.Struct({ type: Schema.Literal("refusal"), refusal: Schema.String }),
          ])
        ),
      }),
      Schema.Struct({
        type: Schema.Literal("function_call"),
        call_id: Schema.String,
        name: Schema.String,
        arguments: Schema.String,
      }),
      Schema.Struct({ type: Schema.Literal("reasoning") }),
    ])
  ),
  usage: Schema.Struct({
    input_tokens: Schema.Finite,
    output_tokens: Schema.Finite,
    total_tokens: Schema.Finite,
  }),
});

type ProviderResponse = typeof ProviderResponse.Type;
type FunctionCallItem = Extract<
  ProviderResponse["output"][number],
  { readonly type: "function_call" }
>;

const workersAiOperationBindings = hostedOperationBindings(operationCatalog).map(
  ({ operation, wireName }) => ({
    operation,
    wireName,
    parameters: Schema.toJsonSchemaDocument(Schema.toEncoded(operation.input)).schema,
  })
);

const operationByWireName = new Map(
  workersAiOperationBindings.map((binding) => [binding.wireName, binding])
);

if (operationByWireName.size !== workersAiOperationBindings.length) {
  throw new Error("Hosted operation aliases must remain unique for Workers AI");
}

const byteLength = (text: string): number => new TextEncoder().encode(text).length;

// GPT-style tokenizers cannot produce more ordinary input tokens than the UTF-8 byte sequence;
// counting bytes is intentionally conservative and never sends content to another tokenizer.
const tokenUpperBound = (value: string): number => byteLength(value);

const promptParts = (
  content: string | ReadonlyArray<Prompt.PartEncoded>
): ReadonlyArray<Prompt.PartEncoded> =>
  typeof content === "string" ? [{ type: "text", text: content }] : content;

const projectAssistant = (
  message: Prompt.AssistantMessageEncoded
): ReadonlyArray<WorkersAiInputItem> =>
  promptParts(message.content).flatMap((part): ReadonlyArray<WorkersAiInputItem> => {
    if (part.type === "text") {
      return [{ role: "assistant", content: [{ type: "input_text", text: part.text }] }];
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
    throw new Error("Hosted context contains unsupported assistant content");
  });

const projectTool = (message: Prompt.ToolMessageEncoded): ReadonlyArray<WorkersAiInputItem> =>
  message.content.map((part) => {
    if (part.type !== "tool-result") {
      throw new Error("Hosted context contains unsupported tool content");
    }
    return {
      type: "function_call_output",
      call_id: part.id,
      output: JSON.stringify(part.result),
      status: "completed",
    };
  });

const projectMessage = (message: Prompt.MessageEncoded): ReadonlyArray<WorkersAiInputItem> => {
  switch (message.role) {
    case "system":
      return [{ role: "system", content: message.content }];
    case "user":
      return [
        {
          role: "user",
          content: promptParts(message.content)
            .map((part) => {
              if (part.type !== "text") {
                throw new Error("Hosted context contains unsupported User media");
              }
              return part.text;
            })
            .join("\n"),
        },
      ];
    case "assistant":
      return projectAssistant(message);
    case "tool":
      return projectTool(message);
  }
};

const projectMessages = (
  basePrefix: ReadonlyArray<Prompt.MessageEncoded>,
  projection: HostedPromptProjection,
  continuation: Option.Option<WorkersAiContinuation>
): Effect.Effect<
  Readonly<{ input: ReadonlyArray<WorkersAiInputItem>; continuationPrefix: WorkersAiContinuation }>,
  HostedInferenceError
> =>
  Effect.try({
    try: () => {
      const prefix = [...basePrefix, ...projection.prefix].flatMap(projectMessage);
      const prior = Option.getOrElse(continuation, () => []);
      const tail = projection.continuationTail.flatMap(projectMessage);
      return {
        input: [...prefix, ...prior, ...tail, ...projection.suffix.flatMap(projectMessage)],
        continuationPrefix: [...prior, ...tail],
      };
    },
    catch: () => invalidProviderOutput("Semantic hosted text projection was invalid"),
  });

const toolsFor = (
  availableOperations: HostedTextToolPolicy["availableOperations"]
): ReadonlyArray<WorkersAiTool> => {
  const available = new Set(availableOperations);
  return workersAiOperationBindings
    .filter(({ operation }) => available.has(operation.id))
    .map(({ operation, parameters, wireName }) => ({
      type: "function",
      name: wireName,
      description: hostedToolDescription(operation),
      parameters,
      strict: true,
    }));
};

const makeRequest = (
  input: ReadonlyArray<WorkersAiInputItem>,
  policy: HostedTextToolPolicy
): WorkersAiRequest => ({
  input,
  max_output_tokens: hostedOutputTokenReserve,
  parallel_tool_calls: false,
  reasoning: { effort: "low" },
  text: { format: { type: "text" } },
  tool_choice: policy.toolChoice,
  tools: toolsFor(policy.availableOperations),
  truncation: "disabled",
});

const capacityCheck = (request: WorkersAiRequest): Effect.Effect<number, HostedInferenceError> => {
  const inputTokens = tokenUpperBound(JSON.stringify(request));
  return inputTokens + hostedOutputTokenReserve > workersAiContextTokens
    ? Effect.fail(
        new HostedInferenceError({
          reason: { _tag: "CapacityExceeded", inputTokens },
          retryable: false,
          retryAfter: Option.none(),
        })
      )
    : Effect.succeed(inputTokens);
};

const decodeChunks = (chunks: ReadonlyArray<Uint8Array>, size: number): string => {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
};

type ResponseBodyCollection = Readonly<{
  chunks: ReadonlyArray<Uint8Array>;
  size: number;
}>;

type ByteReader = Readonly<{
  cancel: () => Promise<void>;
  read: () => Promise<Readonly<{ done: boolean; value: Uint8Array }>>;
}>;

const cancelReader = (reader: ByteReader): Effect.Effect<void> =>
  Effect.tryPromise({
    try: () => reader.cancel(),
    catch: () => undefined,
  }).pipe(Effect.ignore);

const collectResponseBody = (
  reader: ByteReader,
  collection: ResponseBodyCollection,
  overflow: () => HostedInferenceError
): Effect.Effect<string, HostedInferenceError> =>
  Effect.tryPromise({
    try: () => reader.read(),
    catch: () => invalidProviderOutput("Hosted provider response was invalid"),
  }).pipe(
    Effect.flatMap((chunk) => {
      if (chunk.done) {
        return Effect.succeed(decodeChunks(collection.chunks, collection.size));
      }
      const nextSize = collection.size + chunk.value.byteLength;
      if (nextSize > providerResponseMaximumBytes) {
        return cancelReader(reader).pipe(Effect.andThen(Effect.fail(overflow())));
      }
      return collectResponseBody(
        reader,
        { chunks: [...collection.chunks, chunk.value], size: nextSize },
        overflow
      );
    })
  );

const readBoundedBody = (
  response: Response,
  overflow: () => HostedInferenceError
): Effect.Effect<string, HostedInferenceError> => {
  if (response.body === null) {
    return Effect.fail(invalidProviderOutput("Hosted provider response was invalid"));
  }
  const responseReader = response.body.getReader();
  const reader: ByteReader = {
    cancel: () => responseReader.cancel(),
    read: () =>
      responseReader
        .read()
        .then((result) => (result.done ? { done: true, value: new Uint8Array() } : result)),
  };
  return collectResponseBody(reader, { chunks: [], size: 0 }, overflow).pipe(
    Effect.onInterrupt(() => cancelReader(reader))
  );
};

type InvokeInput = Readonly<{
  model: ApprovedWorkersAiModel;
  overflow: () => HostedInferenceError;
  request: WorkersAiRequest;
  run: WorkersAiBindingRun;
  timeout: Duration.Input;
  timeoutFailure: () => HostedInferenceError;
}>;

const hasInvalidUsage = (usage: ProviderResponse["usage"]): boolean =>
  usage.input_tokens < 0 ||
  usage.output_tokens < 0 ||
  usage.total_tokens < 0 ||
  usage.output_tokens > hostedOutputTokenReserve;

const validateProviderResponse = (
  response: ProviderResponse
): Effect.Effect<ProviderResponse, HostedInferenceError> => {
  if (
    response.status === "failed" ||
    response.status === "cancelled" ||
    response.status === "queued" ||
    response.status === "in_progress" ||
    hasInvalidUsage(response.usage) ||
    response.output.some(
      (item) =>
        item.type === "message" && item.content.some((content) => content.type === "refusal")
    )
  ) {
    return Effect.fail(invalidProviderOutput("Hosted provider response was invalid"));
  }
  return Effect.succeed(response);
};

// Hosted-turn orchestration owns the Work span and reports provider failure once. This adapter adds
// no provider span because model attributes and response details are forbidden telemetry.
const invoke = ({
  model,
  overflow,
  request,
  run,
  timeout,
  timeoutFailure,
}: InvokeInput): Effect.Effect<ProviderResponse, HostedInferenceError> =>
  Effect.tryPromise({
    try: (signal) => run(model, request, { returnRawResponse: true, signal }),
    catch: () => providerUnavailable(true),
  }).pipe(
    Effect.flatMap((response) =>
      response.status >= HTTP_OK_MINIMUM && response.status < HTTP_REDIRECTION_MINIMUM
        ? readBoundedBody(response, overflow)
        : Effect.fail(
            providerUnavailable(
              response.status === HTTP_REQUEST_TIMEOUT ||
                response.status === HTTP_TOO_MANY_REQUESTS ||
                response.status >= HTTP_SERVER_ERROR_MINIMUM
            )
          )
    ),
    Effect.flatMap((body) =>
      Schema.decodeEffect(Schema.fromJsonString(ProviderResponse))(body).pipe(
        Effect.mapError(() => invalidProviderOutput("Hosted provider response was invalid"))
      )
    ),
    Effect.flatMap(validateProviderResponse),
    Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail(timeoutFailure()) })
  );

const decodeToolCall = (
  item: FunctionCallItem,
  visibleOperations: HostedTextToolPolicy["availableOperations"]
): Effect.Effect<HostedTextResult["toolCalls"][number], HostedInferenceError> => {
  const binding = Schema.is(HostedOperationWireName)(item.name)
    ? operationByWireName.get(item.name)
    : undefined;
  if (binding === undefined || !visibleOperations.includes(binding.operation.id)) {
    return Effect.fail(invalidProviderOutput("Hosted provider response was invalid"));
  }
  return Effect.try({
    try: () => Tool.unsafeSecureJsonParse(item.arguments),
    catch: () => invalidProviderOutput("Hosted tool arguments were invalid"),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(binding.operation.input)),
    Effect.mapError((error) =>
      error instanceof HostedInferenceError
        ? error
        : invalidProviderOutput("Hosted tool arguments were invalid")
    ),
    Effect.map((params) => ({ id: item.call_id, operation: binding.operation.id, params }))
  );
};

const outputText = (response: ProviderResponse): ReadonlyArray<string> =>
  response.output.flatMap((item) =>
    item.type === "message"
      ? item.content.flatMap((content) => (content.type === "output_text" ? [content.text] : []))
      : []
  );

const finishReason = (
  response: ProviderResponse,
  hasToolCalls: boolean
): HostedTextResult["finishReason"] => {
  if (hasToolCalls) return "tool-calls";
  return response.status === "incomplete" ? "length" : "stop";
};

const decodeResult = (
  response: ProviderResponse,
  request: PreparedWorkersAiRequest
): Effect.Effect<Omit<HostedTextResult, "continuation">, HostedInferenceError> =>
  Effect.gen(function* () {
    const functionCalls = response.output.filter(
      (item): item is FunctionCallItem => item.type === "function_call"
    );
    if (functionCalls.length > request.maximumToolCalls) {
      return yield* invalidProviderOutput(
        "Deterministic model exceeded the hosted tool-call limit"
      );
    }
    const toolCalls = yield* Effect.forEach(functionCalls, (item) =>
      decodeToolCall(item, request.visibleOperations)
    );
    const text = outputText(response).join("");
    if (toolCalls.length === 0 && text.trim().length === 0) {
      return yield* invalidProviderOutput("Hosted provider response was invalid");
    }
    return {
      text,
      toolCalls,
      finishReason: finishReason(response, toolCalls.length > 0),
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
        cachedInputTokens: 0,
      },
    };
  });

const makeStructuredAdapter = (
  run: WorkersAiBindingRun,
  model: ApprovedWorkersAiModel
): HostedStructuredAdapter => ({
  prepare: (input) =>
    Effect.gen(function* () {
      const messages = yield* projectMessages(
        [],
        {
          prefix: input.messages,
          continuationTail: [],
          suffix: [],
          activeRequest: { _tag: "Absent" },
        },
        Option.none()
      );
      const schema = yield* Effect.try({
        try: () => Schema.toJsonSchemaDocument(Schema.toEncoded(input.outputSchema)).schema,
        catch: () => invalidProviderOutput("Hosted structured schema was invalid"),
      });
      const request: WorkersAiRequest = {
        input: messages.input,
        max_output_tokens: hostedOutputTokenReserve,
        parallel_tool_calls: false,
        reasoning: { effort: "low" },
        text: {
          format: { type: "json_schema", name: input.objectName, schema, strict: true },
        },
        tool_choice: "none",
        tools: [],
        truncation: "disabled",
      };
      yield* capacityCheck(request);
      return {
        execute: invoke({
          model,
          overflow: structuredOutputExceeded,
          request,
          run,
          timeout: structuredExecutionTimeout,
          timeoutFailure: structuredOutputTimedOut,
        }).pipe(
          Effect.flatMap((response) =>
            Schema.decodeEffect(Schema.fromJsonString(input.outputSchema))(
              outputText(response).join("")
            ).pipe(
              Effect.mapError(() => invalidProviderOutput("Hosted structured output was malformed"))
            )
          )
        ),
      };
    }),
});

const continuationItems = (response: ProviderResponse): ReadonlyArray<WorkersAiInputItem> =>
  response.output.flatMap((item): ReadonlyArray<WorkersAiInputItem> => {
    if (item.type === "function_call") {
      return [{ ...item, status: "completed" }];
    }
    if (item.type === "message") {
      return [
        {
          role: "assistant",
          content: item.content.flatMap((content) =>
            content.type === "output_text" ? [{ type: "input_text", text: content.text }] : []
          ),
        },
      ];
    }
    return [];
  });

const makeService = (
  run: WorkersAiBindingRun,
  model: ApprovedWorkersAiModel
): HostedInferenceService => {
  const adapter: HostedInferenceAdapter<PreparedWorkersAiRequest, WorkersAiContinuation> = {
    countText: (text) => Effect.succeed(tokenUpperBound(text)),
    countTranscript: (entries: ReadonlyArray<TranscriptEntry>) =>
      projectMessages(
        [],
        {
          prefix: exactTranscriptPromptInternal(entries),
          continuationTail: [],
          suffix: [],
          activeRequest: { _tag: "Absent" },
        },
        Option.none()
      ).pipe(
        Effect.map(({ input }) => tokenUpperBound(JSON.stringify(input))),
        Effect.orDie
      ),
    prepare: (semanticInput) =>
      Effect.gen(function* () {
        const messages = yield* projectMessages(
          semanticInput.basePrefix,
          semanticInput.projection,
          semanticInput.continuation
        );
        const request = makeRequest(messages.input, semanticInput);
        yield* capacityCheck(request);
        return {
          continuationPrefix: messages.continuationPrefix,
          maximumToolCalls:
            semanticInput.toolChoice === "none" ? 0 : semanticInput.maximumToolCalls,
          request,
          visibleOperations: semanticInput.availableOperations,
        };
      }),
    execute: (request) =>
      invoke({
        model,
        overflow: () => invalidProviderOutput("Hosted provider response was invalid"),
        request: request.request,
        run,
        timeout: `${maximumModelRoundMillis} millis`,
        timeoutFailure: () => providerUnavailable(true),
      }).pipe(
        Effect.flatMap((response) =>
          decodeResult(response, request).pipe(
            Effect.map((result) => ({
              result,
              continuation: [...request.continuationPrefix, ...continuationItems(response)],
            }))
          )
        )
      ),
    structured: makeStructuredAdapter(run, model),
  };
  return makeHostedInferenceInternal(adapter);
};

/**
 * Builds direct Workers AI hosted inference. Configuration is decoded before authority exists;
 * unsupported models and absent bindings fail closed without invoking a provider.
 */
export const makeWorkersAiHostedInference = (
  configuration: WorkersAiConfiguration
): Effect.Effect<HostedInferenceService, HostedInferenceError> =>
  Effect.gen(function* () {
    const configuredModel = yield* Effect.fromOption(configuration.model);
    const model = yield* Schema.decodeUnknownEffect(ApprovedWorkersAiModel)(configuredModel);
    const run = yield* Effect.fromOption(configuration.run);
    return makeService(run, model);
  }).pipe(Effect.mapError(() => providerUnavailable(false)));
