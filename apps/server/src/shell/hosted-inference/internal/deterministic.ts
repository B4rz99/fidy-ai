import { OpenAiLanguageModel } from "@effect/ai-openai";
import { Effect, Option, Schema } from "effect";
import { type LanguageModel, Prompt, Tool, Toolkit } from "effect/unstable/ai";
import {
  HostedInferenceError,
  type HostedInferenceService,
  type HostedTextResult,
  type HostedTextToolPolicy,
  type HostedToolCallMaximum,
} from "~/shell/hosted-inference/contract";
import type { HostedInferenceAdapter } from "./adapter";
import { makeHostedInferenceInternal } from "./inference";
import {
  hostedOperationBindings,
  hostedToolDescription,
} from "~/shell/_shared/hosted-operation-bindings";
import type { CatalogOperation } from "~/shell/_shared/operation-catalog";
import { operationCatalog } from "~/shell/api";

const deterministicBindings = hostedOperationBindings(operationCatalog);
const deterministicOperationByWireName = new Map<string, CatalogOperation>(
  deterministicBindings.map(({ operation, wireName }) => [wireName, operation] as const)
);
const DeterministicToolkit = Toolkit.make(
  ...deterministicBindings.map(({ operation, wireName }) =>
    Tool.dynamic(wireName, {
      description: hostedToolDescription(operation),
      parameters: Schema.toEncoded(operation.input),
      success: operation.success,
      failure: operation.failure,
      failureMode: "return",
    })
  )
);

type DeterministicRequest = Readonly<{
  prompt: ReadonlyArray<Prompt.MessageEncoded>;
  toolkit: typeof DeterministicToolkit;
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

type HostedToolCallCapOverride = <A, E, R>(
  effect: Effect.Effect<A, E, R>
) => Effect.Effect<A, E, Exclude<R, OpenAiLanguageModel.Config>>;

const withHostedToolCallCap = (maximum: HostedToolCallMaximum): HostedToolCallCapOverride =>
  OpenAiLanguageModel.withConfigOverride({ max_tool_calls: maximum });

const prepareDeterministic: DeterministicAdapter["prepare"] = (input) => {
  const prompt = [
    ...input.basePrefix,
    ...input.projection.prefix,
    ...Option.getOrElse(input.continuation, () => []),
    ...input.projection.continuationTail,
    ...input.projection.suffix,
  ];
  const providerInput = {
    prompt,
    toolkit: DeterministicToolkit,
    availableOperations: input.availableOperations,
  };
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

const decodeDeterministicToolCalls = (
  calls: ReadonlyArray<Readonly<{ id: string; name: string; params: unknown }>>
): Effect.Effect<HostedTextResult["toolCalls"], HostedInferenceError> =>
  Effect.forEach(calls, (call) =>
    Effect.fromOption(Option.fromNullishOr(deterministicOperationByWireName.get(call.name))).pipe(
      Effect.mapError(
        () =>
          new HostedInferenceError({
            reason: {
              _tag: "InvalidOutput",
              description: "Deterministic hosted output was invalid",
            },
            retryable: false,
            retryAfter: Option.none(),
          })
      ),
      Effect.flatMap((operation) =>
        (Schema.is(operation.input)(call.params)
          ? Effect.succeed(call.params)
          : Schema.decodeEffect(operation.input)(call.params).pipe(
              Effect.mapError(
                () =>
                  new HostedInferenceError({
                    reason: {
                      _tag: "InvalidOutput",
                      description: "Deterministic hosted output was invalid",
                    },
                    retryable: false,
                    retryAfter: Option.none(),
                  })
              )
            )
        ).pipe(Effect.map((params) => ({ id: call.id, operation: operation.id, params })))
      )
    )
  );

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
      Effect.flatMap((response) =>
        decodeDeterministicToolCalls(response.toolCalls).pipe(
          Effect.map((toolCalls) => ({
            result: {
              text: response.text,
              toolCalls,
              finishReason: response.finishReason,
              usage: {
                inputTokens: response.usage.inputTokens.total ?? 0,
                outputTokens: response.usage.outputTokens.total ?? 0,
                cachedInputTokens: response.usage.inputTokens.cacheRead ?? 0,
              },
            },
            continuation: Prompt.fromResponseParts(response.content).content,
          }))
        )
      )
    );
  };

/** Adapts one deterministic model without exposing private prompt preparation. @internal */
export const makeDeterministicHostedInference = (
  model: LanguageModel.Service
): HostedInferenceService =>
  makeHostedInferenceInternal({
    countText: (text) => Effect.succeed(new TextEncoder().encode(text).length),
    countTranscript: (entries) =>
      Effect.succeed(new TextEncoder().encode(JSON.stringify(entries)).length),
    prepare: prepareDeterministic,
    execute: makeDeterministicExecute(model),
    structured: {
      prepare: ({ objectName, outputSchema, messages }) =>
        Effect.succeed({
          execute: model
            .generateObject({
              prompt: messages,
              schema: outputSchema,
              objectName,
            })
            .pipe(
              Effect.mapError(modelFailure),
              Effect.map((response) => response.value)
            ),
        }),
    },
  });
