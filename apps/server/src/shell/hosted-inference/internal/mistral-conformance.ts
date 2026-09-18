import { jsonStringSchema } from "~/shell/schema-codecs/contract";
import { CompactedConversationOutput } from "~/core/transcript/compacted-conversation";
import { Effect, Option, Schema } from "effect";
import type { JsonSchema } from "effect";
import { OutboundHttp } from "~/shell/outbound-http/operations";
import {
  type MistralConformanceCaseId,
  MistralConformanceError,
  type MistralConformanceFailureReason,
  type MistralConformanceReport,
} from "~/shell/hosted-inference/mistral-conformance-contract";
import { type MistralV13Messages, countMistralV13Messages } from "./mistral-tokenizer";
import { hostedOutputTokenReserve } from "./limits";
import { hostedStructuredCompactionObjectName } from "./inference";
import { hostedStructuredCompactionInstruction } from "./prompt";

/** Fixed candidate whose hosted accounting must agree with the pinned local v13 tokenizer. */
export const mistralConformanceModel = "ministral-3b-2512";

const conformanceTimeout = "30 seconds";
const successfulStatusMinimum = 200;
const successfulStatusMaximumExclusive = 300;

const Book = Schema.Struct({ name: Schema.String, authors: Schema.Array(Schema.String) });

const conformanceMessages = [
  {
    role: "system" as const,
    content: hostedStructuredCompactionInstruction,
  },
  {
    role: "user" as const,
    content: "Earlier compacted conversation: the User tracks a grocery budget.",
  },
  { role: "user" as const, content: "User: I paid COP 48,900 for groceries." },
  {
    role: "assistant" as const,
    content: "Assistant: I recorded the grocery purchase.",
  },
] as const;

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
  id: MistralConformanceCaseId;
  messages: MistralV13Messages;
  maxTokens: number;
  responseFormat: Option.Option<ResponseFormat>;
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
  },
  {
    id: "small-schema",
    messages: differentialMessages,
    maxTokens: 64,
    responseFormat: Option.some(jsonSchemaFormat("book", bookJsonSchema)),
  },
  {
    id: "large-schema",
    messages: differentialMessages,
    maxTokens: 64,
    responseFormat: Option.some(
      jsonSchemaFormat("large_differential", largeDifferentialJsonSchema)
    ),
  },
  {
    id: "production-compaction",
    messages: conformanceMessages,
    maxTokens: hostedOutputTokenReserve,
    responseFormat: Option.some(
      jsonSchemaFormat(hostedStructuredCompactionObjectName, productionJsonSchema)
    ),
  },
];

const ProviderResponse = Schema.Struct({
  model: Schema.String,
  usage: Schema.Struct({ prompt_tokens: Schema.Finite }),
});
const ProviderResponseJson = jsonStringSchema(ProviderResponse);

const conformanceError = (
  conformanceCase: ConformanceCase,
  reason: MistralConformanceFailureReason
): MistralConformanceError => new MistralConformanceError({ reason, caseId: conformanceCase.id });

const makeRequestBody = (conformanceCase: ConformanceCase): string =>
  JSON.stringify({
    model: mistralConformanceModel,
    messages: conformanceCase.messages,
    max_tokens: conformanceCase.maxTokens,
    temperature: 0,
    ...Option.match(conformanceCase.responseFormat, {
      onNone: () => ({}),
      onSome: (responseFormat) => ({ response_format: responseFormat }),
    }),
  });

const validateResponse = Effect.fn("MistralConformance.validateResponse")(function* (
  conformanceCase: ConformanceCase,
  decoded: typeof ProviderResponse.Type
) {
  if (decoded.model !== mistralConformanceModel) {
    return yield* conformanceError(conformanceCase, "provider_model_mismatch");
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
  conformanceCase: ConformanceCase
) {
  const outbound = yield* OutboundHttp;
  const response = yield* outbound
    .execute({
      _tag: "MistralChatCompletions",
      body: makeRequestBody(conformanceCase),
    })
    .pipe(
      Effect.timeout(conformanceTimeout),
      Effect.mapError(() => conformanceError(conformanceCase, "provider_failed"))
    );
  if (
    response.status < successfulStatusMinimum ||
    response.status >= successfulStatusMaximumExclusive
  ) {
    return yield* conformanceError(conformanceCase, "provider_failed");
  }
  const decoded = yield* Schema.decodeEffect(ProviderResponseJson)(
    new TextDecoder().decode(response.body)
  ).pipe(Effect.mapError(() => conformanceError(conformanceCase, "provider_response_invalid")));
  return yield* validateResponse(conformanceCase, decoded);
});

/**
 * Runs baseline/small/large schema differentials and a production-shaped Compaction probe.
 * Merely configuring a credential never invokes this function.
 */
export const verifyMistralTokenConformance: Effect.Effect<
  ReadonlyArray<MistralConformanceReport>,
  MistralConformanceError,
  OutboundHttp
> = Effect.forEach(cases, executeCase, { concurrency: 1 });
