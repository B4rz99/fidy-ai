import { Effect, Layer, Option } from "effect";
import { LanguageModel, Prompt } from "effect/unstable/ai";
import {
  HostedInference,
  type HostedInferenceAdapter,
  HostedInferenceError,
  type HostedTextToolPolicy,
  makeHostedInference,
} from "~/shell/agent/hosted-inference";
import { withHostedToolCallCap } from "~/shell/agent/openai";
import { AgentToolkit } from "~/shell/agent/toolkit";

type DeterministicRequest = Readonly<{
  prompt: ReadonlyArray<Prompt.MessageEncoded>;
  toolkit: typeof AgentToolkit;
}> &
  HostedTextToolPolicy;

type DeterministicContinuation = ReadonlyArray<Prompt.MessageEncoded>;

const modelFailure = (
  failure: Effect.Error<ReturnType<LanguageModel.Service["generateText"]>>
): HostedInferenceError =>
  new HostedInferenceError({
    reason:
      failure.reason._tag === "InvalidOutputError"
        ? {
            _tag: "InvalidOutput" as const,
            description: "Deterministic hosted output was invalid" as const,
          }
        : { _tag: "ProviderUnavailable" as const },
    retryable: failure.isRetryable,
    retryAfter: Option.fromNullishOr(failure.retryAfter),
  });

type DeterministicAdapter = HostedInferenceAdapter<DeterministicRequest, DeterministicContinuation>;

const prepareDeterministic: DeterministicAdapter["prepare"] = (input) => {
  const prompt = [
    ...input.basePrefix,
    ...input.projection.prefix,
    ...Option.getOrElse(input.continuation, () => []),
    ...input.projection.continuationTail,
    ...input.projection.suffix,
  ];
  const providerInput = { prompt, toolkit: AgentToolkit };
  return Effect.succeed(
    input.toolChoice === "none"
      ? { ...providerInput, toolChoice: input.toolChoice }
      : {
          ...providerInput,
          toolChoice: input.toolChoice,
          maximumToolCalls: input.maximumToolCalls,
        }
  );
};

const makeDeterministicExecute =
  (model: LanguageModel.Service): DeterministicAdapter["execute"] =>
  (request) => {
    const generated = model.generateText({
      prompt: request.prompt,
      toolkit: request.toolkit,
      toolChoice: request.toolChoice,
      disableToolCallResolution: true,
    });
    const bounded =
      request.toolChoice === "none"
        ? generated
        : generated.pipe(withHostedToolCallCap(request.maximumToolCalls));
    return bounded.pipe(
      Effect.mapError(modelFailure),
      Effect.filterOrFail(
        (response) =>
          request.toolChoice === "none" || response.toolCalls.length <= request.maximumToolCalls,
        () =>
          new HostedInferenceError({
            reason: {
              _tag: "InvalidOutput",
              description: "Deterministic model exceeded the hosted tool-call limit",
            },
            retryable: false,
            retryAfter: Option.none(),
          })
      ),
      Effect.map((response) => ({
        result: {
          text: response.text,
          toolCalls: response.toolCalls,
          finishReason: response.finishReason,
          usage: {
            inputTokens: response.usage.inputTokens.total ?? 0,
            outputTokens: response.usage.outputTokens.total ?? 0,
            cachedInputTokens: response.usage.inputTokens.cacheRead ?? 0,
          },
        },
        continuation: Prompt.fromResponseParts(response.content).content,
      }))
    );
  };

/**
 * Adapts deterministic LanguageModel scripts to HostedInference. The deterministic provider has
 * unbounded context by construction; preparation still stores its complete prompt and toolkit.
 */
export const HostedInferenceFromLanguageModel = Layer.effect(
  HostedInference,
  Effect.map(LanguageModel.LanguageModel, (model) =>
    makeHostedInference({
      countText: (text) => Effect.succeed(new TextEncoder().encode(text).length),
      countTranscript: (entries) =>
        Effect.succeed(new TextEncoder().encode(JSON.stringify(entries)).length),
      prepare: prepareDeterministic,
      execute: makeDeterministicExecute(model),
      structured: {
        prepare: ({ objectName, outputSchema, projection }) =>
          Effect.succeed({
            execute: model
              .generateObject({
                prompt: projection.messages,
                schema: outputSchema,
                objectName,
              })
              .pipe(
                Effect.mapError(modelFailure),
                Effect.map((response) => response.value)
              ),
          }),
      },
    })
  )
);
