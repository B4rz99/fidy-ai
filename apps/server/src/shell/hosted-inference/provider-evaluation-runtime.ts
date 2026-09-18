import { hostedOutputTokenReserve } from "~/shell/hosted-inference/internal/limits";
import { hostedInferenceProviderMetadata } from "~/shell/hosted-inference/internal/openai";

/** Provider-control source whose bytes the evaluator hashes into `generationSha256` evidence. */
export const hostedInferenceEvaluationSourcePath = "src/shell/hosted-inference/internal/openai.ts";

/** Explicit OpenAI evaluation coordinates; not part of the HostedInference contract. */
export const hostedInferenceEvaluationMetadata = Object.freeze({
  ...hostedInferenceProviderMetadata(),
  outputReserveTokens: hostedOutputTokenReserve,
});
