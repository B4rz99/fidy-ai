import { DateTime, Effect, Exit, Option, Schema } from "effect";
import type { Prompt } from "effect/ai";
import { freezeDeep } from "./deep-freeze";
import {
  HostedInferenceError,
  type HostedInferenceService,
  type HostedStructuredContext,
  type HostedStructuredPurpose,
  type HostedStructuredRequest,
  type HostedTextContext,
  type HostedTextContinuation,
  type HostedTextRequest,
  type HostedTextResult,
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

// Structured clone drops Effect DateTime's prototype/identity. Copy semantic instants explicitly
// before freezing the detached context so proactive Transcript codecs still receive DateTime.Utc.
const copyInstant = (value: DateTime.Utc): DateTime.Utc =>
  DateTime.makeUnsafe(DateTime.toEpochMillis(value));
const copyTimestampedEntry = <A extends Readonly<{ occurredAt: DateTime.Utc }>>(entry: A): A => ({
  ...structuredClone(entry),
  occurredAt: copyInstant(entry.occurredAt),
});
const isolateTextContext = (context: HostedTextContext): HostedTextContext =>
  freezeDeep({
    ...structuredClone(context),
    sections: context.sections.map((section) => {
      if (section._tag === "TurnStarted") {
        return { ...structuredClone(section), startedAt: copyInstant(section.startedAt) };
      }
      if (section._tag === "Transcript") {
        return { ...structuredClone(section), entry: copyTimestampedEntry(section.entry) };
      }
      if (section._tag === "ProactiveReply") {
        return { ...structuredClone(section), entry: copyTimestampedEntry(section.entry) };
      }
      return structuredClone(section);
    }),
  });

// `Option` is immutable and not structured-clone-compatible (its `_tag` is an accessor), so only
// the mutable entry array is cloned; sharing the prior keeps `Option.match` working downstream.
const isolateStructuredContext = (context: HostedStructuredContext): HostedStructuredContext =>
  freezeDeep({
    prior: context.prior,
    entries: context.entries.map(copyTimestampedEntry),
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
    ? { toolChoice: "none", availableOperations: freezeDeep([...policy.availableOperations]) }
    : {
        toolChoice: "auto",
        maximumToolCalls: policy.maximumToolCalls,
        availableOperations: freezeDeep([...policy.availableOperations]),
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

// A mixed cause cannot authorize repeating uncertain external work.
const pureFailure = (
  exit: Exit.Exit<unknown, HostedInferenceError>,
  tag: HostedInferenceError["reason"]["_tag"]
): boolean =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.length > 0 &&
  exit.cause.reasons.every(
    (reason) =>
      reason._tag === "Fail" &&
      reason.error.reason._tag === tag &&
      (tag !== "ProviderUnavailable" || reason.error.retryable)
  );

const prepareExecution = <Output>(
  work: Effect.Effect<Output, HostedInferenceError>,
  settled: (exit: Exit.Exit<Output, HostedInferenceError>, retryable: boolean) => void = () => {}
): Readonly<{
  execute: Effect.Effect<Output, HostedInferenceError>;
  discard: Effect.Effect<void, HostedInferenceError>;
}> => {
  let state: "ready" | "executing" | "consumed" = "ready";
  let attempts = 0;
  let captured = Option.some(work);
  const settle = (exit: Exit.Exit<Output, HostedInferenceError>): Effect.Effect<void> =>
    Effect.sync(() => {
      const retryable =
        pureFailure(exit, "ProviderUnavailable") && attempts < maximumHostedProviderAttempts;
      state = retryable ? "ready" : "consumed";
      if (!retryable) captured = Option.none();
      settled(exit, retryable);
    });
  return {
    execute: Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        if (state !== "ready" || Option.isNone(captured)) return Effect.fail(invalidAuthority());
        state = "executing";
        attempts += 1;
        return restore(captured.value).pipe(Effect.onExit(settle));
      })
    ),
    discard: Effect.suspend(() => {
      if (state !== "ready") return Effect.fail(invalidAuthority());
      state = "consumed";
      captured = Option.none();
      return Effect.void;
    }),
  };
};

const consumeSource = <Continuation>(source: ExactPreparation<Continuation>): void => {
  if (Option.isSome(source.source)) source.source.value.guard.consume();
};

const textExecution = <Request, Continuation>(
  runtime: TextRuntime<Request, Continuation>,
  exactRequest: Request,
  input: ExactPreparation<Continuation>
): Effect.Effect<HostedTextResult, HostedInferenceError> =>
  Effect.suspend(() => runtime.adapter.execute(exactRequest)).pipe(
    Effect.map(({ result, continuation }) => {
      consumeSource(input);
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
    })
  );

const makePreparedText = <Request, Continuation>(
  runtime: TextRuntime<Request, Continuation>,
  exactRequest: Request,
  input: ExactPreparation<Continuation>
): PreparedHostedText => {
  let repairInput = Option.some(input);
  let repairAvailable = false;
  const execution = prepareExecution(
    textExecution(runtime, exactRequest, input),
    (exit, retryable) => {
      repairAvailable = pureFailure(exit, "InvalidOutput");
      if (!retryable && !repairAvailable) repairInput = Option.none();
    }
  );
  const repairInvalidOutput = Effect.suspend(() => {
    if (!repairAvailable || Option.isNone(repairInput)) return Effect.fail(invalidAuthority());
    const captured = repairInput.value;
    repairAvailable = false;
    repairInput = Option.none();
    consumeSource(captured);
    return runtime
      .makeContinuation({
        basePrefix: captured.basePrefix,
        continuation: Option.none(),
        policy: captured.policy,
      })
      .prepare([
        {
          _tag: "InvalidOutputFeedback",
          description:
            "La respuesta no cumplió el formato o los argumentos de las herramientas disponibles. Responde al pedido original usando solo herramientas disponibles y argumentos válidos. No inventes identificadores; consulta los datos necesarios primero.",
        },
      ]);
  });
  const discard = Effect.suspend(() => {
    if (repairAvailable && Option.isSome(repairInput)) {
      consumeSource(repairInput.value);
      repairAvailable = false;
      repairInput = Option.none();
      return Effect.void;
    }
    return execution.discard.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (Option.isSome(repairInput)) consumeSource(repairInput.value);
          repairInput = Option.none();
        })
      )
    );
  });
  const execute = execution.execute;
  return makePreparedTextAuthority({ execute, repairInvalidOutput, discard });
};

const prepareContinuation = <Request, Continuation>(
  runtime: TextRuntime<Request, Continuation>,
  state: ContinuationState<Continuation>,
  next: Readonly<{ context: HostedTextContext; policy: HostedTextToolPolicy }>
): Effect.Effect<PreparedHostedText, HostedInferenceError> => {
  const context = projectHostedTextContextInternal(isolateTextContext(next.context));
  const settle = (exit: Exit.Exit<PreparedHostedText, HostedInferenceError>): Effect.Effect<void> =>
    Effect.sync(() => {
      if (Exit.isFailure(exit)) state.guard.restore();
    });
  return Effect.uninterruptibleMask((restore) =>
    Effect.suspend(() => {
      if (!state.guard.begin()) return Effect.fail(invalidAuthority());
      return restore(
        Effect.suspend(() =>
          runtime.prepareExact({
            basePrefix: state.basePrefix,
            projection: context,
            continuation: state.continuation,
            policy: next.policy,
            source: Option.some(state),
          })
        )
      ).pipe(Effect.onExit(settle));
    })
  );
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

const makeStructuredBehavior = <Output>(
  execution: PreparedStructuredExecution<Output>,
  outputSchema: Schema.Codec<Output, Readonly<Record<string, unknown>>, never, never>
): PreparedHostedStructured<Output> => {
  const { execute, discard } = prepareExecution(
    execution.execute.pipe(
      Effect.flatMap(Schema.encodeUnknownEffect(outputSchema)),
      Effect.flatMap((output) =>
        Schema.decodeEffect(outputSchema)(output).pipe(Effect.mapError(invalidStructuredOutput))
      ),
      Effect.mapError((error) =>
        error instanceof HostedInferenceError ? error : invalidStructuredOutput()
      )
    )
  );
  return makePreparedStructuredAuthority({ execute, discard });
};

/** @internal */
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
    const outputSchema = request.outputSchema;
    return adapter
      .prepare({
        messages: projectHostedStructuredContextInternal(context),
        objectName: hostedStructuredObjectNames[request.purpose],
        outputSchema,
      })
      .pipe(Effect.map((execution) => makeStructuredBehavior(execution, outputSchema)));
  },
});

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
