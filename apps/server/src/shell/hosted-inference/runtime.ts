import { Effect, Option, Schema } from "effect";
import {
  ApprovedWorkersAiModel,
  HostedInferenceError,
  type HostedInferenceService,
  type WorkersAiConfiguration,
} from "./contract";
import { makeWorkersAiInferenceServiceInternal } from "~/shell/hosted-inference/internal/workers-ai";

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
    return makeWorkersAiInferenceServiceInternal({ run, model });
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
