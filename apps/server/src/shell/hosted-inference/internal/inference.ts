import { Cause, DateTime, Effect, Exit, Option, Schema } from "effect";
import type { Prompt } from "effect/ai";
import { freezeDeep } from "./deep-freeze";
import {
  HostedActiveRequest,
  HostedContextSection,
  HostedInferenceError,
  HostedInferenceFailureReason,
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
  authorizeContinuation,
  authorizePreparedStructured,
  authorizePreparedText,
  continuationPolicy,
  oneShotPreparation,
} from "./authority";
import type {
  HostedInferenceAdapter,
  HostedPromptProjection,
  HostedStructuredAdapter,
  PreparedStructuredExecution,
} from "./adapter";
import { maximumActiveRequestTokens, maximumHostedProviderAttempts } from "./limits";
import { projectHostedStructuredContextInternal, projectHostedTextContextInternal } from "./prompt";

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
      if (HostedContextSection.$is("TurnStarted")(section)) {
        return { ...structuredClone(section), startedAt: copyInstant(section.startedAt) };
      }

      if (HostedContextSection.$is("Transcript")(section)) {
        return { ...structuredClone(section), entry: copyTimestampedEntry(section.entry) };
      }

      if (HostedContextSection.$is("ProactiveReply")(section)) {
        return { ...structuredClone(section), entry: copyTimestampedEntry(section.entry) };
      }

      return structuredClone(section);
    }),
  });

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

type TextRuntime<Request, Continuation, Requirements> = Readonly<{
  adapter: HostedInferenceAdapter<Request, Continuation, Requirements>;
  prepareExact: (
    input: ExactPreparation<Continuation>
  ) => Effect.Effect<PreparedHostedText<Requirements>, HostedInferenceError>;
  makeContinuation: (input: {
    readonly basePrefix: ReadonlyArray<Prompt.MessageEncoded>;
    readonly continuation: Option.Option<Continuation>;
    readonly policy: HostedTextToolPolicy;
  }) => HostedTextContinuation<Requirements>;
}>;

const invalidAuthority = (): HostedInferenceError =>
  new HostedInferenceError({
    reason: HostedInferenceFailureReason.InvalidAuthority(),
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

const validateActiveRequest = <Request, Continuation, Requirements>(
  adapter: HostedInferenceAdapter<Request, Continuation, Requirements>,
  projection: HostedPromptProjection
): Effect.Effect<void, HostedInferenceError> => {
  const activeRequest = projection.activeRequest;

  return HostedActiveRequest.$is("Absent")(activeRequest)
    ? Effect.void
    : adapter.countText(activeRequest.text).pipe(
        Effect.flatMap((inputTokens) =>
          inputTokens > maximumActiveRequestTokens
            ? Effect.fail(
                new HostedInferenceError({
                  reason: HostedInferenceFailureReason.ActiveRequestCapacityExceeded({
                    inputTokens,
                    maximumTokens: maximumActiveRequestTokens,
                  }),
                  retryable: false,
                  retryAfter: Option.none(),
                })
              )
            : Effect.void
        )
      );
};

const prepareAdapterRequest = <Request, Continuation, Requirements>(
  adapter: HostedInferenceAdapter<Request, Continuation, Requirements>,
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

const pureFailure = (
  exit: Exit.Exit<unknown, HostedInferenceError>,
  tag: HostedInferenceError["reason"]["_tag"]
): boolean =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.length > 0 &&
  exit.cause.reasons.every(
    (reason) =>
      Cause.isFailReason(reason) &&
      HostedInferenceFailureReason.$is(tag)(reason.error.reason) &&
      (tag !== "ProviderUnavailable" || reason.error.retryable)
  );

type ExecutionStatus = "Ready" | "Executing" | "Consumed";

type PreparedExecution<Output, Requirements> = Readonly<{
  execute: Effect.Effect<Output, HostedInferenceError, Requirements>;
  discard: Effect.Effect<void, HostedInferenceError>;
}>;

const prepareExecution = <Output, Requirements>(
  work: Effect.Effect<Output, HostedInferenceError, Requirements>,
  settled: (
    exit: Exit.Exit<Output, HostedInferenceError>,
    retryable: boolean
  ) => void = (): void => {}
): PreparedExecution<Output, Requirements> => {
  let status: ExecutionStatus = "Ready";
  let attempts = 0;

  const settle = (exit: Exit.Exit<Output, HostedInferenceError>): Effect.Effect<void> =>
    Effect.sync(() => {
      if (status !== "Executing") return;

      const retryable =
        pureFailure(exit, "ProviderUnavailable") && attempts < maximumHostedProviderAttempts;

      status = retryable ? "Ready" : "Consumed";
      settled(exit, retryable);
    });

  return {
    execute: Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        if (status !== "Ready") return Effect.fail(invalidAuthority());
        status = "Executing";
        attempts += 1;

        return restore(work).pipe(Effect.onExit(settle));
      })
    ),
    discard: Effect.suspend(() => {
      if (status !== "Ready") return Effect.fail(invalidAuthority());
      status = "Consumed";

      return Effect.void;
    }),
  };
};

const consumeSource = <Continuation>(source: ExactPreparation<Continuation>): void => {
  if (Option.isSome(source.source)) source.source.value.guard.consume();
};

const textExecution = <Request, Continuation, Requirements>(
  runtime: TextRuntime<Request, Continuation, Requirements>,
  exactRequest: Request,
  input: ExactPreparation<Continuation>
): Effect.Effect<HostedTextResult<Requirements>, HostedInferenceError, Requirements> =>
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

type TextRepairStatus = "Pending" | "Available" | "Spent";

const makePreparedText = <Request, Continuation, Requirements>(
  runtime: TextRuntime<Request, Continuation, Requirements>,
  exactRequest: Request,
  input: ExactPreparation<Continuation>
): PreparedHostedText<Requirements> => {
  let repair: TextRepairStatus = "Pending";

  const execution = prepareExecution(
    textExecution(runtime, exactRequest, input),
    (exit, retryable) => {
      if (repair !== "Pending") return;

      if (pureFailure(exit, "InvalidOutput")) repair = "Available";
      else if (!retryable) repair = "Spent";
    }
  );

  const repairInvalidOutput = Effect.suspend(() => {
    if (repair !== "Available") return Effect.fail(invalidAuthority());
    repair = "Spent";
    consumeSource(input);

    return runtime
      .makeContinuation({
        basePrefix: input.basePrefix,
        continuation: Option.none(),
        policy: input.policy,
      })
      .prepare([
        HostedContextSection.InvalidOutputFeedback({
          description:
            "La respuesta no cumplió el formato o los argumentos de las herramientas disponibles. Responde al pedido original usando solo herramientas disponibles y argumentos válidos. No inventes identificadores; consulta los datos necesarios primero.",
        }),
      ]);
  });

  const discard = Effect.suspend(() => {
    if (repair === "Available") {
      consumeSource(input);
      repair = "Spent";

      return Effect.void;
    }

    return execution.discard.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          if (repair === "Pending") consumeSource(input);
          repair = "Spent";
        })
      )
    );
  });

  const execute = execution.execute;

  return authorizePreparedText({ execute, repairInvalidOutput, discard });
};

const prepareContinuation = <Request, Continuation, Requirements>(
  runtime: TextRuntime<Request, Continuation, Requirements>,
  state: ContinuationState<Continuation>,
  next: Readonly<{ context: HostedTextContext; policy: HostedTextToolPolicy }>
): Effect.Effect<PreparedHostedText<Requirements>, HostedInferenceError> => {
  const context = projectHostedTextContextInternal(isolateTextContext(next.context));

  const settle = (
    exit: Exit.Exit<PreparedHostedText<Requirements>, HostedInferenceError>
  ): Effect.Effect<void> =>
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

const makeContinuation = <Request, Continuation, Requirements>(
  runtime: TextRuntime<Request, Continuation, Requirements>,
  input: Readonly<{
    basePrefix: ReadonlyArray<Prompt.MessageEncoded>;
    continuation: Option.Option<Continuation>;
    policy: HostedTextToolPolicy;
  }>
): HostedTextContinuation<Requirements> => {
  const { basePrefix, continuation, policy } = input;

  const state: ContinuationState<Continuation> = {
    guard: oneShotPreparation(),
    continuation,
    basePrefix,
  };

  return authorizeContinuation({
    prepare: (events: Parameters<HostedTextContinuation["prepare"]>[0]) =>
      prepareContinuation(runtime, state, {
        context: { sections: events, activeRequest: HostedActiveRequest.Absent() },
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

const makeTextRuntime = <Request, Continuation, Requirements>(
  adapter: HostedInferenceAdapter<Request, Continuation, Requirements>
): Pick<HostedInferenceService<Requirements>, "prepareText" | "validateText"> => {
  const runtime: TextRuntime<Request, Continuation, Requirements> = {
    adapter,
    prepareExact: (input) =>
      prepareAdapterRequest(adapter, input).pipe(
        Effect.map((request) => makePreparedText(runtime, freezeDeep(request), input))
      ),
    makeContinuation: (input) => makeContinuation(runtime, input),
  };

  const prepareInitial = (
    request: HostedTextRequest
  ): Effect.Effect<PreparedHostedText<Requirements>, HostedInferenceError> =>
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

type HostedStructuredRuntime<Requirements> = Pick<
  HostedInferenceService<Requirements>,
  "prepareStructured"
>;

/* istanbul ignore next */
const invalidStructuredOutput = (): HostedInferenceError =>
  new HostedInferenceError({
    reason: HostedInferenceFailureReason.InvalidOutput({
      description: "Hosted structured output was malformed",
    }),
    retryable: false,
    retryAfter: Option.none(),
  });

const makeStructuredBehavior = <
  Output,
  Encoded extends Readonly<Record<string, unknown>>,
  Requirements,
>(
  execution: PreparedStructuredExecution<Output, Requirements>,
  outputSchema: Schema.Codec<Output, Encoded, never, never>
): PreparedHostedStructured<Output, Requirements> => {
  const { execute, discard } = prepareExecution(
    execution.execute.pipe(
      Effect.flatMap((output) =>
        Schema.encodeUnknownEffect(outputSchema)(output).pipe(
          Effect.flatMap(Schema.decodeEffect(outputSchema)),
          Effect.mapError(invalidStructuredOutput)
        )
      )
    )
  );

  return authorizePreparedStructured({ execute, discard });
};

export const hostedStructuredCompactionObjectName = "compacted_conversation";

const hostedStructuredObjectNames: Readonly<Record<HostedStructuredPurpose, string>> = {
  "conversation-compaction": hostedStructuredCompactionObjectName,
};

const makeHostedStructuredRuntime = <Requirements>(
  adapter: HostedStructuredAdapter<Requirements>
): HostedStructuredRuntime<Requirements> => ({
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

export const hostedInferenceInternal = <Request, Continuation, Requirements>(
  adapter: HostedInferenceAdapter<Request, Continuation, Requirements>
): HostedInferenceService<Requirements> => {
  const textRuntime = makeTextRuntime(adapter);
  const structuredRuntime = makeHostedStructuredRuntime(adapter.structured);

  return {
    countText: adapter.countText,
    countTranscript: adapter.countTranscript,
    ...textRuntime,
    ...structuredRuntime,
  };
};
