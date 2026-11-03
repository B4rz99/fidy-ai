import { Effect, Option, Schema } from "effect";
import {
  ApprovedOpenAiModel,
  HostedInferenceError,
  type HostedInferenceService,
  type OpenAiConfiguration,
} from "./contract";
import { makeOpenAiInferenceServiceInternal } from "~/shell/hosted-inference/internal/openai";

/**
 * Builds direct OpenAI hosted inference. Configuration is decoded before authority exists;
 * unsupported models and absent transports fail closed without invoking a provider.
 */
export const makeOpenAiHostedInference = (
  configuration: OpenAiConfiguration
): Effect.Effect<HostedInferenceService, HostedInferenceError> =>
  Effect.gen(function* () {
    const configuredModel = yield* Effect.fromOption(configuration.model);
    const model = yield* Schema.decodeUnknownEffect(ApprovedOpenAiModel)(configuredModel);
    const run = yield* Effect.fromOption(configuration.run);
    return makeOpenAiInferenceServiceInternal({ run, model });
  }).pipe(
    Effect.mapError(
      () =>
        new HostedInferenceError({
          reason: { _tag: "ProviderUnavailable" },
          retryable: false,
          retryAfter: Option.none(),
        })
    )
  );
