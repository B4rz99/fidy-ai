import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { Config, type Effect, Layer, Schema } from "effect";

/** Direct launch model; model selection is not runtime-configurable. */
export const HostedAgentModel = "gpt-5.6-luna";

/** Fixed generation controls for predictable low-latency hosted turns. */
export const HostedAgentGenerationConfig = {
  temperature: 0.7,
  reasoning: { effort: "none" },
  parallel_tool_calls: false,
  store: false,
} as const;

/** A positive whole-number cap for tool calls in one tools-enabled hosted model request. */
export const HostedToolCallCap = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("HostedToolCallCap")
);
export type HostedToolCallCap = typeof HostedToolCallCap.Type;

type HostedToolCallCapEffect = <A, E, R>(
  effect: Effect.Effect<A, E, R>
) => Effect.Effect<A, E, Exclude<R, OpenAiLanguageModel.Config>>;

/**
 * Caps one hosted OpenAI request to the tool calls the host can still accept. The caller remains
 * responsible for aggregate enforcement and must disable tool calling when the budget is exhausted.
 */
export const withHostedToolCallCap = (maximum: HostedToolCallCap): HostedToolCallCapEffect =>
  OpenAiLanguageModel.withConfigOverride({ max_tool_calls: maximum });

const OpenAiClientLive = OpenAiClient.layerConfig({
  apiKey: Config.redacted("OPENAI_API_KEY"),
});

/** Production Effect AI adapter backed by OpenAI's Responses API. */
export const OpenAiLanguageModelLive = OpenAiLanguageModel.layer({
  model: HostedAgentModel,
  config: HostedAgentGenerationConfig,
}).pipe(Layer.provide(OpenAiClientLive));
