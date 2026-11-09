import { type Duration, Effect, Option, Schema } from "effect";
import { type Prompt, Tool } from "effect/ai";
import { type TranscriptEntry, maximumModelRoundMillis } from "~/core/agent/contract";
import { operationCatalog } from "~/shell/api";
import {
  HostedOperationWireName,
  hostedOperationBindings,
  hostedToolDescription,
} from "~/shell/canonical-operations/operations";
import {
  type ApprovedOpenAiModel,
  HostedInferenceError,
  type HostedInferenceService,
  type HostedInvalidOutputDescription,
  type HostedTextResult,
  type HostedTextToolPolicy,
  type OpenAiRequest,
  type OpenAiRun,
} from "~/shell/hosted-inference/contract";
import type {
  HostedInferenceAdapter,
  HostedPromptProjection,
  HostedStructuredAdapter,
} from "./adapter";
import { makeHostedInferenceInternal } from "./inference";
import { hostedOutputTokenReserve } from "./limits";
import { exactTranscriptPromptInternal } from "./prompt";
import { openAiProviderSchema } from "./provider-schema";
import generatedToolParameters from "./tool-parameters.generated.json";

type OpenAiInputItem = OpenAiRequest["messages"][number];
type OpenAiFunctionCall = NonNullable<
  Extract<OpenAiInputItem, { readonly role: "assistant" }>["tool_calls"]
>[number];
type OpenAiRequestBase = Pick<
  OpenAiRequest,
  "messages" | "max_completion_tokens" | "temperature" | "stream" | "reasoning_effort" | "store"
>;
type OpenAiTool = Extract<OpenAiRequest, { readonly tool_choice: "auto" }>["tools"][number];

type OpenAiContinuation = ReadonlyArray<OpenAiInputItem>;
type PreparedOpenAiRequest = Readonly<{
  continuationPrefix: OpenAiContinuation;
  maximumToolCalls: number;
  request: OpenAiRequest;
  visibleOperations: HostedTextToolPolicy["availableOperations"];
}>;

const bytesPerKibibyte = 1024;
const providerResponseMaximumKibibytes = 512;
const providerResponseMaximumBytes = providerResponseMaximumKibibytes * bytesPerKibibyte;
const hostedContextTokens = 256_000;
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
    prompt_tokens: Schema.Int,
    completion_tokens: Schema.Int,
    total_tokens: Schema.Int,
    prompt_tokens_details: Schema.optionalKey(
      Schema.Struct({
        cached_tokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      })
    ),
  }),
});

type ProviderResponse = typeof ProviderResponse.Type;
type FunctionCallItem = typeof ProviderFunctionCall.Type;

const parametersByWireName = new Map(
  generatedToolParameters.map(({ wireName, parameters }) => [wireName, parameters])
);
const openAiOperationBindings = hostedOperationBindings(operationCatalog).map(
  ({ operation, wireName }) => {
    const parameters = parametersByWireName.get(wireName);
    if (parameters === undefined) throw new Error("Hosted tool parameters must be generated");
    return { operation, wireName, parameters };
  }
);

const operationByWireName = new Map(
  openAiOperationBindings.map((binding) => [binding.wireName, binding])
);

if (operationByWireName.size !== openAiOperationBindings.length) {
  throw new Error("Hosted operation aliases must remain unique for OpenAI");
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
): ReadonlyArray<OpenAiInputItem> => {
  const parts = promptParts(message.content);
  const text = parts.flatMap((part) => (part.type === "text" ? [part.text] : []));
  const toolCalls = parts.flatMap((part): ReadonlyArray<OpenAiFunctionCall> =>
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

const projectTool = (message: Prompt.ToolMessageEncoded): ReadonlyArray<OpenAiInputItem> =>
  message.content.map((part) => {
    if (part.type !== "tool-result") {
      throw new Error("Hosted context contains unsupported tool content");
    }
    return { role: "tool", tool_call_id: part.id, content: JSON.stringify(part.result) };
  });

const projectMessage = (message: Prompt.MessageEncoded): ReadonlyArray<OpenAiInputItem> => {
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
  continuation: Option.Option<OpenAiContinuation>
): Effect.Effect<
  Readonly<{ input: ReadonlyArray<OpenAiInputItem>; continuationPrefix: OpenAiContinuation }>,
  HostedInferenceError
> =>
  Effect.try({
    try: () => {
      const prefix = [...basePrefix, ...projection.prefix].flatMap(projectMessage);
      const prior = Option.getOrElse(continuation, () => []);
      const tail = projection.continuationTail.flatMap(projectMessage);
      const suffix = projection.suffix.flatMap(projectMessage);
      // Put host repair feedback after the initial instructions and before the active request.
      // Preserve continuity framing; late system feedback can be refused as a conversation change.
      const feedbackIndex = prefix.findLastIndex((message) => message.role === "system") + 1;
      return {
        input: [
          ...prefix.slice(0, feedbackIndex),
          ...suffix.filter((message) => message.role === "system"),
          ...prefix.slice(feedbackIndex),
          ...prior,
          ...tail,
          ...suffix.filter((message) => message.role !== "system"),
        ],
        continuationPrefix: [...prior, ...tail],
      };
    },
    catch: () => invalidProviderOutput("Semantic hosted text projection was invalid"),
  });

const toolsFor = (
  availableOperations: HostedTextToolPolicy["availableOperations"]
): ReadonlyArray<OpenAiTool> => {
  const available = new Set(availableOperations);
  return openAiOperationBindings
    .filter(({ operation }) => available.has(operation.id))
    .map(({ operation, parameters, wireName }) => ({
      type: "function",
      function: {
        name: wireName,
        description: hostedToolDescription(operation),
        parameters,
        strict: false,
      },
    }));
};

const makeRequest = (messages: ReadonlyArray<OpenAiInputItem>): OpenAiRequestBase => ({
  messages,
  max_completion_tokens: hostedOutputTokenReserve,
  temperature: 0,
  stream: false,
  reasoning_effort: "none",
  store: false,
});

const makeTextRequest = (
  messages: ReadonlyArray<OpenAiInputItem>,
  policy: HostedTextToolPolicy
): OpenAiRequest => {
  const tools = policy.toolChoice === "auto" ? toolsFor(policy.availableOperations) : [];
  const capabilityFrame: OpenAiInputItem = {
    role: "system",
    content:
      tools.length === 0
        ? "No hay herramientas disponibles en esta ronda. Responde usando solamente la evidencia suministrada; no prometas consultas adicionales como si pudieras ejecutarlas aquí."
        : "Usa solo las herramientas adjuntas a esta ronda. " +
          "Sus descripciones y esquemas definen las consultas posibles. No atribuyas capacidades adicionales a una herramienta; listar Transactions no consulta un Balance bancario.",
  };
  const request = makeRequest([capabilityFrame, ...messages]);
  return policy.toolChoice === "auto" ? { ...request, tool_choice: "auto", tools } : request;
};

const capacityCheck = (request: OpenAiRequest): Effect.Effect<number, HostedInferenceError> => {
  const inputTokens = tokenUpperBound(JSON.stringify(request));
  return inputTokens + hostedOutputTokenReserve > hostedContextTokens
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

const cancelBody = (body: Readonly<{ cancel: () => Promise<void> }>): Effect.Effect<void> =>
  Effect.sync(() => {
    try {
      body.cancel().catch(() => undefined);
    } catch {}
  });

const releaseReader = (reader: ReadableStreamDefaultReader<unknown>): Effect.Effect<void> =>
  cancelBody(reader).pipe(
    Effect.ensuring(
      Effect.try({ try: () => reader.releaseLock(), catch: () => undefined }).pipe(Effect.ignore)
    )
  );

const collectResponseBody = Effect.fnUntraced(function* (
  reader: ReadableStreamDefaultReader<unknown>,
  overflow: () => HostedInferenceError
) {
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  for (;;) {
    const chunk = yield* Effect.tryPromise({
      try: () => reader.read(),
      catch: () => invalidProviderOutput("Hosted provider response was invalid"),
    });
    if (chunk.done) return decodeChunks(chunks, size);
    const bytes = yield* Schema.decodeUnknownEffect(Schema.Uint8Array)(chunk.value).pipe(
      Effect.mapError(() => invalidProviderOutput("Hosted provider response was invalid"))
    );
    if (size + bytes.byteLength > providerResponseMaximumBytes) return yield* overflow();
    if (bytes.byteLength === 0) continue;
    chunks.push(bytes);
    size += bytes.byteLength;
  }
});

const readBoundedBody = (
  response: Response,
  overflow: () => HostedInferenceError
): Effect.Effect<string, HostedInferenceError> => {
  if (response.body === null) {
    return Effect.fail(invalidProviderOutput("Hosted provider response was invalid"));
  }
  const body = response.body;
  return Effect.acquireUseRelease(
    Effect.try({
      try: (): ReadableStreamDefaultReader<unknown> => body.getReader(),
      catch: () => invalidProviderOutput("Hosted provider response was invalid"),
    }),
    (reader) => collectResponseBody(reader, overflow),
    releaseReader
  );
};

type InvokeInput = Readonly<{
  model: ApprovedOpenAiModel;
  overflow: () => HostedInferenceError;
  request: OpenAiRequest;
  run: OpenAiRun;
  timeout: Duration.Input;
  timeoutFailure: () => HostedInferenceError;
}>;

const hasInvalidUsage = (usage: ProviderResponse["usage"]): boolean =>
  usage.prompt_tokens < 0 ||
  usage.completion_tokens < 0 ||
  usage.total_tokens < 0 ||
  usage.completion_tokens > hostedOutputTokenReserve ||
  (usage.prompt_tokens_details?.cached_tokens ?? 0) > usage.prompt_tokens;

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

const ProviderErrors = Schema.fromJsonString(
  Schema.Struct({ error: Schema.Struct({ code: Schema.NullOr(Schema.String) }) })
);

const providerRefusal = (response: Response): Effect.Effect<never, HostedInferenceError> => {
  const fallback = providerUnavailable(
    response.status === HTTP_REQUEST_TIMEOUT ||
      response.status === HTTP_TOO_MANY_REQUESTS ||
      response.status >= HTTP_SERVER_ERROR_MINIMUM
  );
  if (
    response.status !== HTTP_TOO_MANY_REQUESTS ||
    response.headers.get("content-type")?.startsWith("application/json") !== true
  ) {
    return (response.body === null ? Effect.void : cancelBody(response.body)).pipe(
      Effect.andThen(Effect.fail(fallback))
    );
  }
  return readBoundedBody(response, () => fallback).pipe(
    Effect.flatMap((body) => Schema.decodeEffect(ProviderErrors)(body)),
    Effect.map((body) =>
      body.error.code === "insufficient_quota"
        ? new HostedInferenceError({
            reason: { _tag: "ProviderQuotaExceeded" },
            retryable: false,
            retryAfter: Option.none(),
          })
        : fallback
    ),
    Effect.orElseSucceed(() => fallback),
    Effect.flatMap(Effect.fail)
  );
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
  run(model, request).pipe(
    Effect.mapError((failure) =>
      failure instanceof HostedInferenceError ? failure : providerUnavailable(true)
    ),
    Effect.flatMap((response) =>
      response.status >= HTTP_OK_MINIMUM && response.status < HTTP_REDIRECTION_MINIMUM
        ? readBoundedBody(response, overflow)
        : providerRefusal(response)
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
    // Canonical Transcript/tool evidence is wire JSON, not decoded DateTime/Option values.
    Effect.flatMap(Schema.encodeEffect(binding.operation.input)),
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
  request: PreparedOpenAiRequest
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
        cachedInputTokens: response.usage.prompt_tokens_details?.cached_tokens ?? 0,
      },
    };
  });

const makeStructuredAdapter = (
  run: OpenAiRun,
  model: ApprovedOpenAiModel
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
        try: () => openAiProviderSchema(input.outputSchema),
        catch: () => invalidProviderOutput("Hosted structured schema was invalid"),
      });
      const request: OpenAiRequest = {
        ...makeRequest(messages.input),
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
            (response.choices[0].message.tool_calls?.length ?? 0) > 0
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

const continuationItems = (response: ProviderResponse): ReadonlyArray<OpenAiInputItem> => {
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

type ConfiguredOpenAi = Readonly<{
  run: OpenAiRun;
  model: ApprovedOpenAiModel;
}>;

export const makeOpenAiInferenceServiceInternal = ({
  run,
  model,
}: ConfiguredOpenAi): HostedInferenceService => {
  const adapter: HostedInferenceAdapter<PreparedOpenAiRequest, OpenAiContinuation> = {
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
        const request = makeTextRequest(messages.input, semanticInput);
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
