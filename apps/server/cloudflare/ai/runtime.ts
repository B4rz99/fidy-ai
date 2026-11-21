import type { OutboundHttpFailure } from "../../src/shell/outbound-http/contract";
import { type OpenAiEnvironment } from "./contract";
import { openAiHostedInference } from "../../src/shell/hosted-inference/runtime";
import { Context, Effect, Layer, Option, Redacted, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import {
  HostedInferenceError,
  HostedInferenceFailureReason,
  type HostedInferenceService,
  type OpenAiRequest,
  type OpenAiRun,
} from "../../src/shell/hosted-inference/contract";
import { openAiOutboundHttp } from "../../src/shell/outbound-http/operations";
import { OutboundHttpLive } from "../outbound-http/runtime";

const transportFailure = (
  failure: OutboundHttpFailure,
  request: OpenAiRequest
): HostedInferenceError => {
  let reason: HostedInferenceFailureReason = HostedInferenceFailureReason.ProviderUnavailable();

  if (failure.reason === "response-too-large") {
    reason =
      request.response_format === undefined
        ? HostedInferenceFailureReason.InvalidOutput({
            description: "Hosted provider response was invalid",
          })
        : HostedInferenceFailureReason.StructuredOutputExceeded();
  }

  return new HostedInferenceError({
    reason,
    retryable: failure.reason !== "response-too-large",
    retryAfter: Option.none(),
  });
};

export const openAiRun =
  (apiKey: Redacted.Redacted<string>): OpenAiRun =>
  (model, request) =>
    Effect.gen(function* () {
      const services = yield* Layer.build(OutboundHttpLive);
      const client = Context.get(services, HttpClient.HttpClient);

      const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        model,
        ...request,
      }).pipe(
        Effect.tapError(Effect.logError),
        Effect.mapError(
          () =>
            new HostedInferenceError({
              reason: HostedInferenceFailureReason.InvalidOutput({
                description: "Hosted provider response was invalid",
              }),
              retryable: false,
              retryAfter: Option.none(),
            })
        )
      );

      const response = yield* openAiOutboundHttp({ apiKey, client })
        .execute(body)
        .pipe(Effect.mapError((failure) => transportFailure(failure, request)));

      return new Response(new Uint8Array(response.body), {
        status: response.status,
        headers: response.headers,
      });
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch), Effect.scoped);

const ApiKey = Schema.String.check(Schema.isPattern(/^[!-~]+$/u));

export const makeLocalHostedInference = ({
  environment,
  admit,
}: {
  environment: OpenAiEnvironment;
  admit: (units: number) => Effect.Effect<boolean, HostedInferenceError>;
}): Effect.Effect<HostedInferenceService, HostedInferenceError> => {
  const key = Schema.decodeOption(ApiKey)(environment.OPENAI_API_KEY);

  return openAiHostedInference({
    model: Option.fromNullishOr(environment.HOSTED_AI_MODEL),
    run: Option.map(key, (apiKey) => {
      const run = openAiRun(Redacted.make(apiKey));

      return (model, request) =>
        Effect.gen(function* () {
          const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
            request
          ).pipe(
            Effect.tapError(Effect.logError),
            Effect.mapError(
              () =>
                new HostedInferenceError({
                  reason: HostedInferenceFailureReason.InvalidAuthority(),
                  retryable: false,
                  retryAfter: Option.none(),
                })
            )
          );

          if (
            !(yield* admit(
              new TextEncoder().encode(encoded).length + request.max_completion_tokens
            ))
          ) {
            return yield* new HostedInferenceError({
              reason: HostedInferenceFailureReason.ResourceLimit(),
              retryable: false,
              retryAfter: Option.none(),
            });
          }

          return yield* run(model, request);
        });
    }),
  });
};

export const cloudflareHostedInference = (
  environment: OpenAiEnvironment
): Effect.Effect<HostedInferenceService, HostedInferenceError> =>
  openAiHostedInference({
    model: Option.fromNullishOr(environment.HOSTED_AI_MODEL),
    run: Option.map(Schema.decodeOption(ApiKey)(environment.OPENAI_API_KEY), (apiKey) =>
      openAiRun(Redacted.make(apiKey))
    ),
  });
