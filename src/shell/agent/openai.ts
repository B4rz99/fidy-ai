import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { Config, Layer } from "effect";

/** Direct launch model; model selection is not runtime-configurable. */
export const HostedAgentModel = "gpt-5.4-nano";

const OpenAiClientLive = OpenAiClient.layerConfig({
  apiKey: Config.redacted("OPENAI_API_KEY"),
});

/** Production Effect AI adapter backed by OpenAI's Responses API. */
export const OpenAiLanguageModelLive = OpenAiLanguageModel.layer({
  model: HostedAgentModel,
}).pipe(Layer.provide(OpenAiClientLive));
