import { Effect, Option, Schema } from "effect";
import {
  ApprovedOpenAiModel,
  HostedInferenceError,
  HostedInferenceFailureReason,
  type HostedInferenceService,
  type OpenAiConfiguration,
} from "./contract";
import { makeOpenAiInferenceServiceInternal } from "~/shell/hosted-inference/internal/openai";

const unavailableProvider = (): HostedInferenceError =>
  new HostedInferenceError({
    reason: HostedInferenceFailureReason.ProviderUnavailable(),
    retryable: false,
    retryAfter: Option.none(),
  });

export const openAiHostedInference = (
  configuration: OpenAiConfiguration
): Effect.Effect<HostedInferenceService, HostedInferenceError> =>
  Effect.gen(function* () {
    const configuredModel = yield* Effect.fromOption(configuration.model);
    const model = yield* Schema.decodeUnknownEffect(ApprovedOpenAiModel)(configuredModel);
    const run = yield* Effect.fromOption(configuration.run);

    return makeOpenAiInferenceServiceInternal({ run, model });
  }).pipe(Effect.mapError(unavailableProvider));
