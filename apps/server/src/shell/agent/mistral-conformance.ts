import { jsonStringSchema } from "~/schema-compatibility";
import { CompactedConversationOutput } from "~/core/transcript/compacted-conversation";
import { Data, Effect, Option, Redacted, Schema } from "effect";
import type { JsonSchema } from "effect";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { makeBoundedExternalHttpClient } from "~/shell/_shared/bounded-external-http";
import { type MistralV13Messages, countMistralV13Messages } from "./mistral-tokenizer";
import { makeSyntheticConversationCompactionContext } from "./conversation-compaction-context";
import { hostedOutputTokenReserve } from "./hosted-inference";

/** Fixed candidate whose hosted accounting must agree with the pinned local v13 tokenizer. */
export const mistralConformanceModel = "ministral-3b-2512";

const maximumConformanceResponseBytes = 1_000_000;
const conformanceTimeout = "30 seconds";
const successfulStatusMinimum = 200;
const successfulStatusMaximumExclusive = 300;

const Book = Schema.Struct({ name: Schema.String, authors: Schema.Array(Schema.String) });
const CompactedConversationJson = jsonStringSchema(CompactedConversationOutput);
const BookJson = jsonStringSchema(Book);

type ResponseFormat = Readonly<{
  type: "json_schema";
  json_schema: Readonly<{
    name: string;
    strict: true;
    schema: JsonSchema.JsonSchema;
  }>;
}>;

const jsonSchemaFormat = (name: string, schema: JsonSchema.JsonSchema): ResponseFormat => ({
  type: "json_schema",
  json_schema: { name, strict: true, schema },
});

const bookJsonSchema = Schema.toJsonSchemaDocument(Book).schema;
const productionJsonSchema = Schema.toJsonSchemaDocument(CompactedConversationOutput).schema;
const largeSchemaDescription = Array.from(
  { length: 100 },
  (_, index) => `Differential schema description segment ${index}.`
).join(" ");
const largeDifferentialJsonSchema: JsonSchema.JsonSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: largeSchemaDescription },
    authors: {
      type: "array",
      items: { type: "string" },
      description: largeSchemaDescription,
    },
  },
  required: ["name", "authors"],
  additionalProperties: false,
};

type ConformanceCase = Readonly<{
  id: "baseline" | "small-schema" | "large-schema" | "production-compaction";
  messages: MistralV13Messages;
  maxTokens: number;
  responseFormat: Option.Option<ResponseFormat>;
  validateContent: Option.Option<(content: string) => Effect.Effect<unknown, Schema.SchemaError>>;
}>;

const differentialMessages: MistralV13Messages = [
  { role: "system", content: "Extract the books information." },
  {
    role: "user",
    content: "I recently read To Kill a Mockingbird by Harper Lee.",
  },
];

const cases: ReadonlyArray<ConformanceCase> = [
  {
    id: "baseline",
    messages: differentialMessages,
    maxTokens: 64,
    responseFormat: Option.none(),
    validateContent: Option.none(),
  },
  {
    id: "small-schema",
    messages: differentialMessages,
    maxTokens: 64,
    responseFormat: Option.some(jsonSchemaFormat("book", bookJsonSchema)),
    validateContent: Option.some((content) =>
      Schema.decodeEffect(BookJson)(content, { onExcessProperty: "error", errors: "all" })
    ),
  },
  {
    id: "large-schema",
    messages: differentialMessages,
    maxTokens: 64,
    responseFormat: Option.some(
      jsonSchemaFormat("large_differential", largeDifferentialJsonSchema)
    ),
    validateContent: Option.some((content) =>
      Schema.decodeEffect(BookJson)(content, { onExcessProperty: "error", errors: "all" })
    ),
  },
  {
    id: "production-compaction",
    messages: makeSyntheticConversationCompactionContext().messages,
    maxTokens: hostedOutputTokenReserve,
    responseFormat: Option.some(jsonSchemaFormat("compacted_conversation", productionJsonSchema)),
    validateContent: Option.some((content) =>
      Schema.decodeEffect(CompactedConversationJson)(content, {
        onExcessProperty: "error",
        errors: "all",
      })
    ),
  },
];

const ProviderResponse = Schema.Struct({
  id: Schema.String,
  object: Schema.String,
  created: Schema.Finite,
  model: Schema.String,
  choices: Schema.NonEmptyArray(
    Schema.Struct({
      index: Schema.Finite,
      message: Schema.Struct({
        role: Schema.String,
        content: Schema.String,
        prefix: Schema.Boolean,
        tool_calls: Schema.NullOr(Schema.Array(Schema.Unknown)),
      }),
      finish_reason: Schema.String,
    })
  ),
  usage: Schema.Struct({
    prompt_tokens: Schema.Finite,
    completion_tokens: Schema.Finite,
    total_tokens: Schema.Finite,
  }),
});
const ProviderResponseJson = jsonStringSchema(ProviderResponse);

/** Safe closed reasons emitted by the manual conformance workflow. */
export type MistralConformanceFailureReason =
  | "provider_failed"
  | "provider_response_invalid"
  | "provider_model_mismatch"
  | "prompt_count_mismatch"
  | "structured_output_invalid";

/** Content-free failure from the manual Mistral conformance workflow. */
export class MistralConformanceError extends Data.TaggedError("MistralConformanceError")<{
  readonly reason: MistralConformanceFailureReason;
  readonly caseId: ConformanceCase["id"];
}> {}

/** Safe numeric evidence from one hosted accounting probe. */
export type MistralConformanceReport = Readonly<{
  id: ConformanceCase["id"];
  localPromptTokens: number;
  hostedPromptTokens: number;
  outputReserve: number;
  completeRequestTokens: number;
}>;

const conformanceError = (
  conformanceCase: ConformanceCase,
  reason: MistralConformanceFailureReason
): MistralConformanceError => new MistralConformanceError({ reason, caseId: conformanceCase.id });

const makeRequest = (
  conformanceCase: ConformanceCase,
  apiKey: Redacted.Redacted<string>
): HttpClientRequest.HttpClientRequest => {
  const requestBody = {
    model: mistralConformanceModel,
    messages: conformanceCase.messages,
    max_tokens: conformanceCase.maxTokens,
    temperature: 0,
    ...Option.match(conformanceCase.responseFormat, {
      onNone: () => ({}),
      onSome: (responseFormat) => ({ response_format: responseFormat }),
    }),
  };
  return HttpClientRequest.post("https://api.mistral.ai/v1/chat/completions").pipe(
    HttpClientRequest.setHeader("authorization", `Bearer ${Redacted.value(apiKey)}`),
    HttpClientRequest.setHeader("content-type", "application/json"),
    HttpClientRequest.setBody(
      HttpBody.uint8Array(new TextEncoder().encode(JSON.stringify(requestBody)))
    )
  );
};

const decodeResponse = (
  conformanceCase: ConformanceCase,
  status: number,
  body: Uint8Array
): Effect.Effect<typeof ProviderResponse.Type, MistralConformanceError> => {
  if (status < successfulStatusMinimum || status >= successfulStatusMaximumExclusive) {
    return Effect.fail(conformanceError(conformanceCase, "provider_failed"));
  }
  return Schema.decodeEffect(ProviderResponseJson)(new TextDecoder().decode(body), {
    onExcessProperty: "error",
    errors: "all",
  }).pipe(Effect.mapError(() => conformanceError(conformanceCase, "provider_response_invalid")));
};

const validateResponse = Effect.fn("MistralConformance.validateResponse")(function* (
  conformanceCase: ConformanceCase,
  decoded: typeof ProviderResponse.Type
) {
  if (decoded.model !== mistralConformanceModel) {
    return yield* conformanceError(conformanceCase, "provider_model_mismatch");
  }
  const content = decoded.choices[0].message.content;
  if (Option.isSome(conformanceCase.validateContent)) {
    yield* conformanceCase.validateContent
      .value(content)
      .pipe(Effect.mapError(() => conformanceError(conformanceCase, "structured_output_invalid")));
  }
  const localPromptTokens = countMistralV13Messages(conformanceCase.messages);
  if (decoded.usage.prompt_tokens !== localPromptTokens) {
    return yield* conformanceError(conformanceCase, "prompt_count_mismatch");
  }
  return {
    id: conformanceCase.id,
    localPromptTokens,
    hostedPromptTokens: decoded.usage.prompt_tokens,
    outputReserve: conformanceCase.maxTokens,
    completeRequestTokens: localPromptTokens + conformanceCase.maxTokens,
  } satisfies MistralConformanceReport;
});

const executeCase = Effect.fn("MistralConformance.executeCase")(function* (
  conformanceCase: ConformanceCase,
  apiKey: Redacted.Redacted<string>
) {
  const client = yield* HttpClient.HttpClient;
  const bounded = client.pipe(makeBoundedExternalHttpClient("mistral"));
  const response = yield* bounded
    .execute(makeRequest(conformanceCase, apiKey), maximumConformanceResponseBytes)
    .pipe(
      Effect.timeout(conformanceTimeout),
      Effect.mapError(() => conformanceError(conformanceCase, "provider_failed"))
    );
  const decoded = yield* decodeResponse(conformanceCase, response.status, response.body);
  return yield* validateResponse(conformanceCase, decoded);
});

/**
 * Runs baseline/small/large schema differentials and a production-shaped Compaction probe.
 * Merely configuring a credential never invokes this function.
 */
export const verifyMistralTokenConformance = (
  apiKey: Redacted.Redacted<string>
): Effect.Effect<
  ReadonlyArray<MistralConformanceReport>,
  MistralConformanceError,
  HttpClient.HttpClient
> =>
  Effect.forEach(cases, (conformanceCase) => executeCase(conformanceCase, apiKey), {
    concurrency: 1,
  });
