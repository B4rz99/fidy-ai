import type { OutboundHttpFailure } from "../../src/shell/outbound-http/contract";
import { OpenAiAdmissionUnavailable, type OpenAiEnvironment } from "./contract";
import { makeAdmittedOpenAiRun } from "./internal/admitted-run";
import { HostedInference } from "../../src/shell/hosted-inference/operations";
import { makeOpenAiHostedInference } from "../../src/shell/hosted-inference/runtime";
import { Context, Effect, Layer, Option, Redacted, Schema, type Scope } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import type { TranscriptTurnId } from "../../src/core/agent/contract";
import { sweepExpiredOpenAiAdmission as expireAdmission } from "./internal/admission-retention";
import {
  HostedInferenceError,
  type HostedInferenceFailureReason,
  type HostedInferenceService,
  type OpenAiRequest,
  type OpenAiRun,
} from "../../src/shell/hosted-inference/contract";
import { makeOpenAiOutboundHttp } from "../../src/shell/outbound-http/operations";
import { OutboundHttpLive } from "../outbound-http/runtime";

const transportFailure = (
  failure: OutboundHttpFailure,
  request: OpenAiRequest
): HostedInferenceError => {
  let reason: HostedInferenceFailureReason = { _tag: "ProviderUnavailable" };
  if (failure.reason === "response-too-large") {
    reason =
      request.response_format === undefined
        ? { _tag: "InvalidOutput", description: "Hosted provider response was invalid" }
        : { _tag: "StructuredOutputExceeded" };
  }
  return new HostedInferenceError({
    reason,
    retryable: failure.reason !== "response-too-large",
    retryAfter: Option.none(),
  });
};

/** Fixed OpenAI transport; its Response contains only bytes already bounded by Outbound HTTP. */
export const makeOpenAiRun =
  (apiKey: Redacted.Redacted<string>): OpenAiRun =>
  (model, request) =>
    Effect.gen(function* () {
      const services = yield* Layer.build(OutboundHttpLive);
      const client = Context.get(services, HttpClient.HttpClient);
      const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        model,
        ...request,
      }).pipe(
        Effect.mapError(
          () =>
            new HostedInferenceError({
              reason: {
                _tag: "InvalidOutput",
                description: "Hosted provider response was invalid",
              },
              retryable: false,
              retryAfter: Option.none(),
            })
        )
      );
      const response = yield* makeOpenAiOutboundHttp({ apiKey, client })
        .execute(body)
        .pipe(Effect.mapError((failure) => transportFailure(failure, request)));
      return new Response(new Uint8Array(response.body), {
        status: response.status,
        headers: response.headers,
      });
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch), Effect.scoped);

const ApiKey = Schema.String.check(Schema.isPattern(/^[!-~]+$/u));

const constructInference = (
  environment: OpenAiEnvironment,
  admission?: Readonly<{
    db: D1Database;
    userId: string;
    admittedTurnId: () => Option.Option<TranscriptTurnId>;
  }>
): Effect.Effect<HostedInferenceService, HostedInferenceError> => {
  const key = Schema.decodeOption(ApiKey)(environment.OPENAI_API_KEY);
  return makeOpenAiHostedInference({
    model: Option.fromNullishOr(environment.HOSTED_AI_MODEL),
    run: Option.map(key, (apiKey) => {
      const run = makeOpenAiRun(Redacted.make(apiKey));
      return admission === undefined ? run : makeAdmittedOpenAiRun({ ...admission, run });
    }),
  });
};

/** Unmetered inference exists only for private provider verification fixtures. */
export const makeCloudflareHostedInference = (
  environment: OpenAiEnvironment
): Effect.Effect<HostedInferenceService, HostedInferenceError> => constructInference(environment);

/** Production inference rechecks User-owned Consent and spend authority at every provider egress. */
export const makeUserCloudflareHostedInference = ({
  environment,
  db,
  userId,
  admittedTurnId,
}: Readonly<{
  environment: OpenAiEnvironment;
  db: D1Database;
  userId: string;
  admittedTurnId: () => Option.Option<TranscriptTurnId>;
}>): Effect.Effect<HostedInferenceService, HostedInferenceError> =>
  constructInference(environment, { db, userId, admittedTurnId });

export const cloudflareHostedInferenceLive = ({
  environment,
  db,
  userId,
  admittedTurnId,
}: Readonly<{
  environment: OpenAiEnvironment;
  db: D1Database;
  userId: string;
  admittedTurnId: () => Option.Option<TranscriptTurnId>;
}>): Layer.Layer<HostedInference, HostedInferenceError> =>
  HostedInference.layer(
    makeUserCloudflareHostedInference({ environment, db, userId, admittedTurnId })
  );

/** Absent inference does not prevent unrelated canonical owners from being available. */
export const optionalHostedInference = (
  input: Parameters<typeof cloudflareHostedInferenceLive>[0]
): Effect.Effect<Option.Option<HostedInferenceService>, never, Scope.Scope> =>
  Layer.build(cloudflareHostedInferenceLive(input)).pipe(
    Effect.option,
    Effect.map(Option.map((services) => Context.get(services, HostedInference)))
  );

export const sweepExpiredOpenAiAdmission = (
  input: Readonly<{ db: D1Database; now: number }>
): Effect.Effect<void, OpenAiAdmissionUnavailable> =>
  expireAdmission(input).pipe(Effect.mapError(() => new OpenAiAdmissionUnavailable()));
