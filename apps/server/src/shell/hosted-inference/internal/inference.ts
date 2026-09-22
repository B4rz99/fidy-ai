import { Effect, Exit, Option, Schema } from "effect";
import type { Prompt } from "effect/unstable/ai";
import { freezeDeep } from "~/shell/_shared/deep-freeze";
import {
  HostedInferenceError,
  type HostedInferenceService,
  type HostedStructuredContext,
  type HostedStructuredPurpose,
  type HostedStructuredRequest,
  type HostedTextContext,
  type HostedTextContinuation,
  type HostedTextRequest,
  type HostedTextToolPolicy,
  type HostedTextValidationRequest,
  type PreparedHostedStructured,
  type PreparedHostedText,
} from "~/shell/hosted-inference/contract";
import {
  type OneShotPreparation,
  continuationPolicy,
  makeContinuationAuthority,
  makeOneShotPreparation,
  makePreparedLifecycleTransitions,
  makePreparedStructuredAuthority,
  makePreparedTextAuthority,
} from "./authority";
import type {
  HostedInferenceAdapter,
  HostedPromptProjection,
  HostedStructuredAdapter,
  PreparedStructuredExecution,
} from "./adapter";
import { maximumActiveRequestTokens, maximumHostedProviderAttempts } from "./limits";
import { projectHostedStructuredContextInternal, projectHostedTextContextInternal } from "./prompt";

const isolateTextContext = (context: HostedTextContext): HostedTextContext =>
  freezeDeep(structuredClone(context));

// `Option` is immutable and not structured-clone-compatible (its `_tag` is an accessor), so only
// the mutable entry array is cloned; sharing the prior keeps `Option.match` working downstream.
const isolateStructuredContext = (context: HostedStructuredContext): HostedStructuredContext =>
  freezeDeep({
    prior: context.prior,
    entries: structuredClone(context.entries),
  });

type ContinuationState<Continuation> = {
  guard: OneShotPreparation;
  continuation: Option.Option<Continuation>;
  basePrefix: ReadonlyArray<Prompt.MessageEncoded>;
};
type ExactPreparation<Continuation> = Readonly<{
  basePrefix: ReadonlyArray<Prompt.MessageEncoded>;
  projection: HostedPromptProjection;
  continuation: Option.Option<Continuation>;
  policy: HostedTextToolPolicy;
  source: Option.Option<ContinuationState<Continuation>>;
}>;
type TextRuntime<Request, Continuation> = Readonly<{
  adapter: HostedInferenceAdapter<Request, Continuation>;
  prepareExact: (
    input: ExactPreparation<Continuation>
  ) => Effect.Effect<PreparedHostedText, HostedInferenceError>;
  makeContinuation: (input: {
    readonly basePrefix: ReadonlyArray<Prompt.MessageEncoded>;
    readonly continuation: Option.Option<Continuation>;
    readonly policy: HostedTextToolPolicy;
  }) => HostedTextContinuation;
}>;

const invalidAuthority = (): HostedInferenceError =>
  new HostedInferenceError({
    reason: { _tag: "InvalidAuthority" },
    retryable: false,
    retryAfter: Option.none(),
  });

const toolPolicy = (policy: HostedTextToolPolicy): HostedTextToolPolicy =>
  policy.toolChoice === "none"
    ? { toolChoice: "none", availableOperations: policy.availableOperations }
    : {
        toolChoice: "auto",
        maximumToolCalls: policy.maximumToolCalls,
        availableOperations: policy.availableOperations,
      };

const validateActiveRequest = <Request, Continuation>(
  adapter: HostedInferenceAdapter<Request, Continuation>,
  projection: HostedPromptProjection
): Effect.Effect<void, HostedInferenceError> => {
  const activeRequest = projection.activeRequest;
  return activeRequest._tag === "Absent"
    ? Effect.void
    : adapter.countText(activeRequest.text).pipe(
        Effect.flatMap((inputTokens) =>
          inputTokens > maximumActiveRequestTokens
            ? Effect.fail(
                new HostedInferenceError({
                  reason: {
                    _tag: "ActiveRequestCapacityExceeded",
                    inputTokens,
                    maximumTokens: maximumActiveRequestTokens,
                  },
                  retryable: false,
                  retryAfter: Option.none(),
                })
              )
            : Effect.void
        )
      );
};

const prepareAdapterRequest = <Request, Continuation>(
  adapter: HostedInferenceAdapter<Request, Continuation>,
  input: ExactPreparation<Continuation>
): Effect.Effect<Request, HostedInferenceError> =>
  validateActiveRequest(adapter, input.projection).pipe(
    Effect.andThen(
      adapter.prepare(
        input.policy.toolChoice === "none"
          ? {
              basePrefix: input.basePrefix,
              projection: input.projection,
              continuation: input.continuation,
              toolChoice: "none",
              availableOperations: input.policy.availableOperations,
            }
          : {
              basePrefix: input.basePrefix,
              projection: input.projection,
              continuation: input.continuation,
              toolChoice: "auto",
              maximumToolCalls: input.policy.maximumToolCalls,
              availableOperations: input.policy.availableOperations,
            }
      )
    )
  );

type FailedExecution = (
  exit: Exit.Exit<unknown, HostedInferenceError>
) => Option.Option<HostedInferenceError>;

const failedExecution: FailedExecution = (exit) => {
  if (!Exit.isFailure(exit)) return Option.none();
  const failure = exit.cause.reasons.find((reason) => reason._tag === "Fail");
  return failure?._tag === "Fail" ? Option.some(failure.error) : Option.none();
};

const makePreparedText = <Request, Continuation>(
  runtime: TextRuntime<Request, Continuation>,
  exactRequest: Request,
  input: ExactPreparation<Continuation>
): PreparedHostedText => {
  const lifecycle = makePreparedLifecycleTransitions();
  const consumeSource = (): void => {
    if (Option.isSome(input.source)) input.source.value.guard.consume();
  };
  const execute = Effect.suspend(() => {
    if (!lifecycle.beginExecution()) return Effect.fail(invalidAuthority());
    return runtime.adapter.execute(exactRequest).pipe(
      Effect.map(({ result, continuation }) => {
        lifecycle.completeExecution();
        consumeSource();
        return {
          ...result,
          continuation: runtime.makeContinuation({
            basePrefix: input.basePrefix,
            continuation: Option.some(continuation),
            policy: continuationPolicy({
              policy: input.policy,
              consumedToolCalls: result.toolCalls.length,
            }),
          }),
        };
      }),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          const failure = failedExecution(exit);
          if (Option.isSome(failure)) return lifecycle.failExecution(failure.value);
          if (lifecycle.current() === "executing") lifecycle.completeExecution();
        })
      )
    );
  });
  const recover = Effect.suspend(() => {
    if (!lifecycle.beginRecovery()) return Effect.fail(invalidAuthority());
    consumeSource();
    return Effect.succeed(
      runtime.makeContinuation({
        basePrefix: input.basePrefix,
        continuation: Option.none(),
        policy: input.policy,
      })
    );
  });
  const discard = Effect.suspend(() => {
    if (!lifecycle.beginDiscard()) return Effect.fail(invalidAuthority());
    consumeSource();
    return Effect.void;
  });
  return makePreparedTextAuthority({ execute, recover, discard });
};

const prepareContinuation = <Request, Continuation>(
  runtime: TextRuntime<Request, Continuation>,
  state: ContinuationState<Continuation>,
  next: Readonly<{ context: HostedTextContext; policy: HostedTextToolPolicy }>
): Effect.Effect<PreparedHostedText, HostedInferenceError> => {
  const context = projectHostedTextContextInternal(isolateTextContext(next.context));
  return Effect.suspend(() => {
    if (!state.guard.begin()) return Effect.fail(invalidAuthority());
    return runtime
      .prepareExact({
        basePrefix: state.basePrefix,
        projection: context,
        continuation: state.continuation,
        policy: next.policy,
        source: Option.some(state),
      })
      .pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isFailure(exit)) state.guard.restore();
          })
        )
      );
  });
};

const makeContinuation = <Request, Continuation>(
  runtime: TextRuntime<Request, Continuation>,
  input: Readonly<{
    basePrefix: ReadonlyArray<Prompt.MessageEncoded>;
    continuation: Option.Option<Continuation>;
    policy: HostedTextToolPolicy;
  }>
): HostedTextContinuation => {
  const { basePrefix, continuation, policy } = input;
  const state: ContinuationState<Continuation> = {
    guard: makeOneShotPreparation(),
    continuation,
    basePrefix,
  };
  return makeContinuationAuthority({
    prepare: (events: Parameters<HostedTextContinuation["prepare"]>[0]) =>
      prepareContinuation(runtime, state, {
        context: { sections: events, activeRequest: { _tag: "Absent" } },
        policy,
      }),
  });
};

type InitialPreparation = <Continuation>(
  request: HostedTextValidationRequest
) => ExactPreparation<Continuation>;

const initialPreparation: InitialPreparation = (request) => {
  const context = projectHostedTextContextInternal(isolateTextContext(request.context));
  return {
    basePrefix: context.prefix,
    projection: { ...context, prefix: [] },
    continuation: Option.none(),
    policy: toolPolicy(request),
    source: Option.none(),
  };
};

const makeTextRuntime = <Request, Continuation>(
  adapter: HostedInferenceAdapter<Request, Continuation>
): Pick<HostedInferenceService, "prepareText" | "validateText"> => {
  const runtime: TextRuntime<Request, Continuation> = {
    adapter,
    prepareExact: (input) =>
      prepareAdapterRequest(adapter, input).pipe(
        Effect.map((request) => makePreparedText(runtime, freezeDeep(request), input))
      ),
    makeContinuation: (input) => makeContinuation(runtime, input),
  };
  const prepareInitial = (
    request: HostedTextRequest
  ): Effect.Effect<PreparedHostedText, HostedInferenceError> =>
    runtime.prepareExact(initialPreparation(request));
  const validateInitial = (
    request: HostedTextValidationRequest
  ): Effect.Effect<void, HostedInferenceError> =>
    prepareAdapterRequest(adapter, initialPreparation(request)).pipe(Effect.asVoid);
  return {
    prepareText: prepareInitial,
    validateText: validateInitial,
  };
};

type HostedStructuredRuntime = Pick<HostedInferenceService, "prepareStructured">;

/* istanbul ignore next */
const invalidStructuredOutput = (): HostedInferenceError =>
  new HostedInferenceError({
    reason: { _tag: "InvalidOutput", description: "Hosted structured output was malformed" },
    retryable: false,
    retryAfter: Option.none(),
  });

/* istanbul ignore next */
const isRetryableProviderFailure = (exit: Exit.Exit<unknown, HostedInferenceError>): boolean =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.some(
    (reason) =>
      reason._tag === "Fail" &&
      reason.error.reason._tag === "ProviderUnavailable" &&
      reason.error.retryable
  );

const makeStructuredBehavior = <Output>(
  execution: PreparedStructuredExecution<Output>,
  outputSchema: Schema.Codec<Output, Readonly<Record<string, unknown>>, never, never>
): PreparedHostedStructured<Output> => {
  let state: "ready" | "executing" | "consumed" = "ready";
  let executionAttempts = 0;
  const execute = Effect.suspend(() => {
    if (state !== "ready" || executionAttempts >= maximumHostedProviderAttempts) {
      return Effect.fail(invalidAuthority());
    }
    state = "executing";
    executionAttempts += 1;
    return execution.execute.pipe(
      Effect.flatMap(Schema.encodeUnknownEffect(outputSchema)),
      Effect.flatMap((output) =>
        Schema.decodeEffect(outputSchema)(output).pipe(Effect.mapError(invalidStructuredOutput))
      ),
      Effect.mapError((error) =>
        error instanceof HostedInferenceError ? error : invalidStructuredOutput()
      ),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          state =
            isRetryableProviderFailure(exit) && executionAttempts < maximumHostedProviderAttempts
              ? "ready"
              : "consumed";
        })
      )
    );
  });
  const discard = Effect.suspend(() => {
    if (state !== "ready") return Effect.fail(invalidAuthority());
    state = "consumed";
    return Effect.void;
  });
  return makePreparedStructuredAuthority({ execute, discard });
};

/** Provider object name every structured conversation-compaction projection requests. @internal */
export const hostedStructuredCompactionObjectName = "compacted_conversation";

const hostedStructuredObjectNames: Readonly<Record<HostedStructuredPurpose, string>> = {
  "conversation-compaction": hostedStructuredCompactionObjectName,
};

const makeHostedStructuredRuntime = (
  adapter: HostedStructuredAdapter
): HostedStructuredRuntime => ({
  prepareStructured: <Output, Encoded extends Readonly<Record<string, unknown>>>(
    request: HostedStructuredRequest<Output, Encoded>
  ) => {
    const context = isolateStructuredContext(request.context);
    return adapter
      .prepare({
        messages: projectHostedStructuredContextInternal(context),
        objectName: hostedStructuredObjectNames[request.purpose],
        outputSchema: request.outputSchema,
      })
      .pipe(Effect.map((execution) => makeStructuredBehavior(execution, request.outputSchema)));
  },
});

/** Gives one adapter one-shot ownership of its prepared requests and continuations. */
export const makeHostedInferenceInternal = <Request, Continuation>(
  adapter: HostedInferenceAdapter<Request, Continuation>
): HostedInferenceService => {
  const textRuntime = makeTextRuntime(adapter);
  const structuredRuntime = makeHostedStructuredRuntime(adapter.structured);
  return {
    countText: adapter.countText,
    countTranscript: adapter.countTranscript,
    ...textRuntime,
    ...structuredRuntime,
  };
};
