import {
  HostedInference,
  type HostedInferenceError,
  type HostedInferenceService,
  type WorkersAiBindingRun,
  makeWorkersAiHostedInference,
} from "@fidy/server/hosted-inference";
import type { Effect } from "effect";
import { type Layer, Option } from "effect";

/** Core bindings required to construct hosted inference without any external-model route. */
export type WorkersAiEnvironment = Readonly<{
  AI: Readonly<{ run: WorkersAiBindingRun }>;
  HOSTED_AI_MODEL: string;
}>;

/**
 * Builds hosted inference from the direct native binding. Missing binding or model configuration
 * fails before authority is returned; the wrapper always requests a bounded raw response and passes
 * Effect interruption to Cloudflare.
 */
export const makeCloudflareHostedInference = (
  environment: WorkersAiEnvironment
): Effect.Effect<HostedInferenceService, HostedInferenceError> => {
  const binding = Option.fromNullishOr(environment.AI);
  return makeWorkersAiHostedInference({
    model: Option.fromNullishOr(environment.HOSTED_AI_MODEL),
    run: Option.map(
      binding,
      (ai) => (model, request, options) =>
        ai.run(model, request, {
          returnRawResponse: options.returnRawResponse,
          signal: options.signal,
        })
    ),
  });
};

/** Cloudflare-configured production composition for operations that require hosted inference. */
export const cloudflareHostedInferenceLive = (
  environment: WorkersAiEnvironment
): Layer.Layer<HostedInference, HostedInferenceError> =>
  HostedInference.layer(makeCloudflareHostedInference(environment));
