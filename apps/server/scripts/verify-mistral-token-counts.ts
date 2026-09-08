#!/usr/bin/env bun

import { BunRuntime } from "@effect/platform-bun";
import { Config, Console, Effect, Redacted, Schema } from "effect";
import { UnknownJsonString, jsonStringSchema } from "../src/schema-compatibility";
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { makeBoundedExternalHttpClient } from "../src/shell/_shared/bounded-external-http";
import {
  type MistralStructuredCountedRequest,
  countMistralStructuredRequest,
} from "../src/shell/agent/mistral-tokenizer";

const model = "ministral-3b-2512";
const endpoint = "https://api.mistral.ai/v1/chat/completions";
const responseMaximumBytes = 64_000;
const requestTimeout = "30 seconds";
const successfulStatusMinimum = 200;
const successfulStatusMaximumExclusive = 300;

const ProviderResponse = Schema.Struct({
  usage: Schema.Struct({ prompt_tokens: Schema.Int }),
  choices: Schema.NonEmptyArray(
    Schema.Struct({ message: Schema.Struct({ content: Schema.String }) })
  ),
});

const Book = Schema.Struct({ name: Schema.String, authors: Schema.Array(Schema.String) });
const CompactedConversation = Schema.Struct({ compactedConversation: Schema.String });

type ConformanceCase = Readonly<{
  id: string;
  request: MistralStructuredCountedRequest;
  validateOutput: (input: string) => Effect.Effect<void, string>;
}>;

const validateWith = <A>(
  schema: Schema.Codec<A, unknown, never, never>
): ConformanceCase["validateOutput"] =>
  ((input: string) =>
    Schema.decodeEffect(jsonStringSchema(schema))(input).pipe(
      Effect.asVoid,
      Effect.mapError(() => "invalid_output" as const)
    )) satisfies ConformanceCase["validateOutput"];

const cases: ReadonlyArray<ConformanceCase> = [
  {
    id: "official-book",
    request: {
      messages: [
        { role: "system", content: "Extract the books information." },
        {
          role: "user",
          content: "I recently read To Kill a Mockingbird by Harper Lee.",
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "book",
          strict: true,
          schema: {
            type: "object",
            properties: {
              name: { type: "string" },
              authors: { type: "array", items: { type: "string" } },
            },
            required: ["name", "authors"],
            additionalProperties: false,
          },
        },
      },
    },
    validateOutput: validateWith(Book),
  },
  {
    id: "es-co-compaction",
    request: {
      messages: [
        {
          role: "system",
          content: "Conserva continuidad financiera, no inventes hechos.",
        },
        {
          role: "user",
          content:
            "Resumí: pagué $48.900 en Éxito y después recibí una devolución de $12.300. ¿Cuánto gasté neto? 🇨🇴",
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "compacted_conversation",
          strict: true,
          schema: {
            type: "object",
            properties: { compactedConversation: { type: "string" } },
            required: ["compactedConversation"],
            additionalProperties: false,
          },
        },
      },
    },
    validateOutput: validateWith(CompactedConversation),
  },
];

const verifyCase = (
  conformanceCase: ConformanceCase,
  apiKey: Redacted.Redacted<string>
): Effect.Effect<void, string, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const transport = yield* HttpClient.HttpClient;
    const client = transport.pipe(makeBoundedExternalHttpClient("mistral"));
    const localPromptTokens = countMistralStructuredRequest(conformanceCase.request);
    const response = yield* client
      .execute(
        HttpClientRequest.post(endpoint, {
          headers: {
            authorization: `Bearer ${Redacted.value(apiKey)}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: HttpBody.jsonUnsafe({
            model,
            messages: conformanceCase.request.messages,
            response_format: conformanceCase.request.response_format,
            temperature: 0,
            max_tokens: 64,
          }),
        }),
        responseMaximumBytes
      )
      .pipe(
        Effect.mapError(() => "provider_unavailable" as const),
        Effect.timeout(requestTimeout),
        Effect.mapError(() => "provider_unavailable" as const)
      );
    if (
      response.status < successfulStatusMinimum ||
      response.status >= successfulStatusMaximumExclusive
    ) {
      yield* Console.error(`${conformanceCase.id}: provider status ${response.status}`);
      return yield* Effect.fail("provider_status");
    }

    const decoded = yield* Schema.decodeEffect(jsonStringSchema(ProviderResponse))(
      new TextDecoder().decode(response.body)
    ).pipe(Effect.mapError(() => "invalid_response" as const));
    yield* conformanceCase.validateOutput(decoded.choices[0].message.content);
    const providerPromptTokens = decoded.usage.prompt_tokens;
    const matches = providerPromptTokens === localPromptTokens;
    const report = yield* Schema.encodeEffect(UnknownJsonString)({
      case: conformanceCase.id,
      model,
      localPromptTokens,
      providerPromptTokens,
      matches,
      outputValidated: true,
    }).pipe(Effect.mapError(() => "invalid_report" as const));
    yield* Console.log(report);
    if (!matches) return yield* Effect.fail("token_mismatch");
  });

const program = Effect.gen(function* () {
  const apiKey = yield* Config.redacted("MISTRAL_API_KEY");
  let failed = false;
  for (const conformanceCase of cases) {
    const exit = yield* Effect.exit(verifyCase(conformanceCase, apiKey));
    if (exit._tag === "Failure") {
      failed = true;
      yield* Console.error(`${conformanceCase.id}: conformance case failed`);
    }
  }
  if (failed) return yield* Effect.fail("conformance_failed");
}).pipe(
  Effect.catch(() =>
    Console.error(
      "Mistral token conformance failed; no request or response content was logged"
    ).pipe(Effect.andThen(Effect.sync(() => (process.exitCode = 1))))
  ),
  // This manual command is the application entry point that owns the HTTP client lifetime.
  // @effect-diagnostics-next-line strictEffectProvide:off
  Effect.provide(FetchHttpClient.layer)
);

BunRuntime.runMain(program);
