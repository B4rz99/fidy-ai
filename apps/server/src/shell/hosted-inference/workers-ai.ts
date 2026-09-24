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

const ChatContent = Schema.NullOr(Schema.String);

/** Provider input item accepted by the direct binding; callers must use projected content only. */
export type WorkersAiFunctionCall = Readonly<{
  id: string;
  type: "function";
  function: Readonly<{ name: string; arguments: string }>;
}>;

export type WorkersAiInputItem =
  | Readonly<{ role: "system" | "user"; content: string }>
  | (Readonly<{
      role: "assistant";
      content: typeof ChatContent.Type;
    }> &
      Partial<Readonly<{ tool_calls: ReadonlyArray<WorkersAiFunctionCall> }>>)
  | Readonly<{ role: "tool"; tool_call_id: string; content: string }>;

/** Strict function tool definition derived from one canonical operation schema. */
export type WorkersAiTool = Readonly<{
  type: "function";
  function: Readonly<{
    name: string;
    description: string;
    parameters: JsonSchema.JsonSchema;
    strict: true;
  }>;
}>;

/** Closed direct-binding request shape; gateway routing and provider-side storage are unavailable. */
export type WorkersAiRequest = Readonly<{
  messages: ReadonlyArray<WorkersAiInputItem>;
  max_tokens: number;
  temperature: 0;
  stream: false;
  chat_template_kwargs: Readonly<{ enable_thinking: false }>;
}> &
  Partial<
    Readonly<{
      response_format: Readonly<{
        type: "json_schema";
        json_schema: Readonly<{
          name: string;
          schema: JsonSchema.JsonSchema;
          strict: true;
        }>;
      }>;
      tool_choice: "auto";
      tools: ReadonlyArray<WorkersAiTool>;
    }>
  >;

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
const workersAiContextTokens = 256_000;
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

const ProviderFunctionCall = Schema.Struct({
  id: Schema.String,
  type: Schema.Literal("function"),
  function: Schema.Struct({ name: Schema.String, arguments: Schema.String }),
});

const ProviderResponse = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({
        role: Schema.Literal("assistant"),
        content: Schema.NullOr(Schema.String),
        refusal: Schema.optionalKey(Schema.NullOr(Schema.String)),
        tool_calls: Schema.optionalKey(Schema.Array(ProviderFunctionCall)),
      }),
      finish_reason: Schema.Literals([
        "stop",
        "length",
        "tool_calls",
        "content_filter",
        "function_call",
      ]),
    })
  ),
  usage: Schema.Struct({
    prompt_tokens: Schema.Finite,
    completion_tokens: Schema.Finite,
    total_tokens: Schema.Finite,
  }),
});

type ProviderResponse = typeof ProviderResponse.Type;
type FunctionCallItem = typeof ProviderFunctionCall.Type;

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

// Byte-backed text tokenization cannot produce more ordinary input tokens than the UTF-8 bytes;
// counting bytes is intentionally conservative and never sends content to another tokenizer.
const tokenUpperBound = (value: string): number => byteLength(value);

const promptParts = (
  content: string | ReadonlyArray<Prompt.PartEncoded>
): ReadonlyArray<Prompt.PartEncoded> =>
  typeof content === "string" ? [{ type: "text", text: content }] : content;

const projectAssistant = (
  message: Prompt.AssistantMessageEncoded
): ReadonlyArray<WorkersAiInputItem> => {
  const parts = promptParts(message.content);
  const text = parts.flatMap((part) => (part.type === "text" ? [part.text] : []));
  const toolCalls = parts.flatMap((part): ReadonlyArray<WorkersAiFunctionCall> =>
    part.type === "tool-call"
      ? [
          {
            id: part.id,
            type: "function",
            function: { name: part.name, arguments: JSON.stringify(part.params) },
          },
        ]
      : []
  );
  if (text.length + toolCalls.length !== parts.length) {
    throw new Error("Hosted context contains unsupported assistant content");
  }
  return [
    {
      role: "assistant",
      content: text.length > 0 ? text.join("\n") : null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    },
  ];
};

const projectTool = (message: Prompt.ToolMessageEncoded): ReadonlyArray<WorkersAiInputItem> =>
  message.content.map((part) => {
    if (part.type !== "tool-result") {
      throw new Error("Hosted context contains unsupported tool content");
    }
    return { role: "tool", tool_call_id: part.id, content: JSON.stringify(part.result) };
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
      function: {
        name: wireName,
        description: hostedToolDescription(operation),
        parameters,
        strict: true,
      },
    }));
};

const makeRequest = (
  messages: ReadonlyArray<WorkersAiInputItem>,
  policy: HostedTextToolPolicy
): WorkersAiRequest => ({
  messages,
  max_tokens: hostedOutputTokenReserve,
  temperature: 0,
  stream: false,
  chat_template_kwargs: { enable_thinking: false },
  ...(policy.toolChoice === "auto"
    ? { tool_choice: "auto" as const, tools: toolsFor(policy.availableOperations) }
    : {}),
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
  usage.prompt_tokens < 0 ||
  usage.completion_tokens < 0 ||
  usage.total_tokens < 0 ||
  usage.completion_tokens > hostedOutputTokenReserve;

const invalidCompletion = (choice: ProviderResponse["choices"][number]): boolean =>
  choice.finish_reason === "content_filter" ||
  choice.finish_reason === "function_call" ||
  (choice.finish_reason === "length" && (choice.message.tool_calls?.length ?? 0) > 0) ||
  choice.message.refusal != null;

const validateProviderResponse = (
  response: ProviderResponse
): Effect.Effect<ProviderResponse, HostedInferenceError> => {
  const choice = response.choices[0];
  if (
    choice === undefined ||
    response.choices.length !== 1 ||
    invalidCompletion(choice) ||
    hasInvalidUsage(response.usage)
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
  const binding = Schema.is(HostedOperationWireName)(item.function.name)
    ? operationByWireName.get(item.function.name)
    : undefined;
  if (binding === undefined || !visibleOperations.includes(binding.operation.id)) {
    return Effect.fail(invalidProviderOutput("Hosted provider response was invalid"));
  }
  return Effect.try({
    try: () => Tool.unsafeSecureJsonParse(item.function.arguments),
    catch: () => invalidProviderOutput("Hosted tool arguments were invalid"),
  }).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(binding.operation.input)),
    Effect.mapError((error) =>
      error instanceof HostedInferenceError
        ? error
        : invalidProviderOutput("Hosted tool arguments were invalid")
    ),
    Effect.map((params) => ({ id: item.id, operation: binding.operation.id, params }))
  );
};

const outputText = (response: ProviderResponse): string =>
  response.choices[0]?.message.content ?? "";

const finishReason = (
  response: ProviderResponse,
  hasToolCalls: boolean
): HostedTextResult["finishReason"] => {
  if (hasToolCalls) return "tool-calls";
  return response.choices[0]?.finish_reason === "length" ? "length" : "stop";
};

const decodeResult = (
  response: ProviderResponse,
  request: PreparedWorkersAiRequest
): Effect.Effect<Omit<HostedTextResult, "continuation">, HostedInferenceError> =>
  Effect.gen(function* () {
    const functionCalls = response.choices[0]?.message.tool_calls ?? [];
    if (functionCalls.length > request.maximumToolCalls) {
      return yield* invalidProviderOutput(
        "Deterministic model exceeded the hosted tool-call limit"
      );
    }
    const toolCalls = yield* Effect.forEach(functionCalls, (item) =>
      decodeToolCall(item, request.visibleOperations)
    );
    const text = outputText(response);
    if (toolCalls.length === 0 && text.trim().length === 0) {
      return yield* invalidProviderOutput("Hosted provider response was invalid");
    }
    return {
      text,
      toolCalls,
      finishReason: finishReason(response, toolCalls.length > 0),
      usage: {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
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
        ...makeRequest(messages.input, { toolChoice: "none", availableOperations: [] }),
        response_format: {
          type: "json_schema",
          json_schema: { name: input.objectName, schema, strict: true },
        },
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
            response.choices[0]?.finish_reason !== "stop" ||
            (response.choices[0]?.message.tool_calls?.length ?? 0) > 0
              ? Effect.fail(structuredOutputExceeded())
              : Schema.decodeEffect(Schema.fromJsonString(input.outputSchema))(
                  outputText(response)
                ).pipe(
                  Effect.mapError(() =>
                    invalidProviderOutput("Hosted structured output was malformed")
                  )
                )
          )
        ),
      };
    }),
});

const continuationItems = (response: ProviderResponse): ReadonlyArray<WorkersAiInputItem> => {
  const message = response.choices[0]?.message;
  if (message === undefined) return [];
  return [
    {
      role: "assistant",
      content: message.content,
      ...(message.tool_calls === undefined ? {} : { tool_calls: message.tool_calls }),
    },
  ];
};

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
