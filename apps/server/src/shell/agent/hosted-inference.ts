import { Context, Data, Effect, Exit, Function as Fn, Option, Schema } from "effect";
import type { Duration } from "effect";
import type { Prompt, Response } from "effect/unstable/ai";
import type { TranscriptEntry } from "~/core/transcript/model";
import { freezeDeep } from "~/shell/_shared/deep-freeze";
import { type WorkingContext, claimWorkingContext } from "./working-context";

/** Semantic prompt sections around provider-owned continuation items. @internal */
export type HostedTextProjection = Readonly<{
  prefix: ReadonlyArray<Prompt.MessageEncoded>;
  continuationTail: ReadonlyArray<Prompt.MessageEncoded>;
  suffix: ReadonlyArray<Prompt.MessageEncoded>;
}>;

/** Opaque semantic text context accepted only by HostedInference. */
export type HostedTextContext = object;

/** Semantic messages claimable once by HostedInference for structured generation. @internal */
type HostedStructuredProjection = Readonly<{
  messages: ReadonlyArray<Prompt.MessageEncoded>;
}>;

/** Opaque semantic context for one structured generation. */
export type HostedStructuredContext = object;

type HostedContextAuthority<A> = Readonly<{ claim: () => Option.Option<A> }>;

const hostedContextAuthorityPrototype: object = Object.freeze({});

const hostedContextAuthority = <A extends unknown>(projection: A): object => {
  let available = true;
  const isolated = freezeDeep(structuredClone(projection));
  const authority = Fn.cast<object, HostedContextAuthority<A>>({});
  Object.setPrototypeOf(authority, hostedContextAuthorityPrototype);
  Object.defineProperty(authority, "claim", {
    enumerable: false,
    value: (): Option.Option<A> => {
      if (!available) return Option.none();
      available = false;
      return Option.some(isolated);
    },
  });
  return Object.freeze(authority);
};

const claimHostedContext = <A extends unknown>(context: unknown): Option.Option<A> =>
  typeof context === "object" &&
  context !== null &&
  Object.getPrototypeOf(context) === hostedContextAuthorityPrototype
    ? Fn.cast<unknown, HostedContextAuthority<A>>(context).claim()
    : Option.none();

/** Isolates semantic prompt sections behind one closure-backed claim. @internal */
export const makeHostedTextContext = (projection: HostedTextProjection): HostedTextContext =>
  hostedContextAuthority(projection);

/** Isolates structured semantic messages behind one closure-backed claim. @internal */
export const makeHostedStructuredContext = (
  projection: HostedStructuredProjection
): HostedStructuredContext => hostedContextAuthority(projection);

/** One-shot prepared hosted text request. */
export type PreparedHostedText = Readonly<{
  execute: Effect.Effect<HostedTextResult, HostedInferenceError>;
  recover: Effect.Effect<HostedTextContinuation, HostedInferenceError>;
  discard: Effect.Effect<void, HostedInferenceError>;
}>;

/** One-shot prepared strict structured request. */
export type PreparedHostedStructured<Output> = Readonly<{
  execute: Effect.Effect<Output, HostedInferenceError>;
  discard: Effect.Effect<void, HostedInferenceError>;
}>;

/** Adapter-local continuation behavior; callers can only prepare a bounded next request. */
export type HostedTextContinuation = Readonly<{
  prepare: (
    context: HostedTextContext,
    policy: HostedTextToolPolicy
  ) => Effect.Effect<PreparedHostedText, HostedInferenceError>;
}>;

const maximumStructuredObjectNameLength = 64;

/** Provider-compatible object name fixed during structured preparation. */
export const HostedStructuredObjectName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(maximumStructuredObjectNameLength),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/)
).pipe(Schema.brand("HostedStructuredObjectName"));
export type HostedStructuredObjectName = typeof HostedStructuredObjectName.Type;

/** Domain schema and semantic context for one strict structured generation. */
export type HostedStructuredRequest<
  Output,
  Encoded extends Readonly<Record<string, unknown>>,
> = Readonly<{
  context: HostedStructuredContext;
  objectName: HostedStructuredObjectName;
  outputSchema: Schema.Codec<Output, Encoded, never, never>;
}>;

/** Allowlisted invalid-output descriptions safe for retry feedback and telemetry. */
export type HostedInvalidOutputDescription =
  | "Semantic hosted text projection was invalid"
  | "Hosted provider response was invalid"
  | "Hosted tool arguments were invalid"
  | "Deterministic hosted output was invalid"
  | "Deterministic model exceeded the hosted tool-call limit"
  | "Hosted structured schema was invalid"
  | "Hosted structured provider response was invalid"
  | "Hosted structured output was malformed";

/** Closed hosted inference failure vocabulary. */
export type HostedInferenceFailureReason =
  | Readonly<{ _tag: "InvalidAuthority" }>
  | Readonly<{ _tag: "CapacityExceeded"; inputTokens: number }>
  | Readonly<{ _tag: "InvalidOutput"; description: HostedInvalidOutputDescription }>
  | Readonly<{ _tag: "ProviderUnavailable" }>
  | Readonly<{ _tag: "StructuredOutputExceeded" }>
  | Readonly<{ _tag: "StructuredOutputTimedOut" }>;

const hostedInferenceErrorMessages: Readonly<Record<HostedInferenceFailureReason["_tag"], string>> =
  {
    InvalidAuthority: "The hosted inference authority is invalid for this adapter",
    CapacityExceeded: "The complete hosted request exceeds provider capacity",
    InvalidOutput: "The hosted provider returned invalid output",
    ProviderUnavailable: "The hosted provider is unavailable",
    StructuredOutputExceeded: "The hosted structured response exceeded its bound",
    StructuredOutputTimedOut: "The hosted structured request timed out",
  };

/** Safe failure returned by preparation or execution without exposing provider request content. */
export class HostedInferenceError extends Data.TaggedError("HostedInferenceError")<{
  readonly reason: HostedInferenceFailureReason;
  readonly retryable: boolean;
  readonly retryAfter: Option.Option<Duration.Duration>;
}> {
  override get message(): string {
    return hostedInferenceErrorMessages[this.reason._tag];
  }
}

/** Positive maximum for one tools-enabled hosted request. */
export const HostedToolCallMaximum = Schema.Int.check(Schema.isGreaterThan(0)).pipe(
  Schema.brand("HostedToolCallMaximum")
);
export type HostedToolCallMaximum = typeof HostedToolCallMaximum.Type;

/** Canonical tools are always present; `none` forbids calls and `auto` bounds their count. */
export type HostedTextToolPolicy =
  | Readonly<{ toolChoice: "none" }>
  | Readonly<{ toolChoice: "auto"; maximumToolCalls: HostedToolCallMaximum }>;

/** One semantic hosted text request whose provider details remain adapter-owned. */
export type InitialHostedTextRequest = Readonly<{
  _tag: "Initial";
  context: WorkingContext | HostedTextContext;
}> &
  HostedTextToolPolicy;

/** One initial WorkingContext request; later rounds are prepared directly by their continuation. */
export type HostedTextRequest = InitialHostedTextRequest;

/** Provider-neutral usage needed by bounded telemetry. */
export type HostedTextUsage = Readonly<{
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
}>;

/** Provider-neutral function call returned for canonical validation and execution. */
export type HostedTextToolCall = Readonly<{
  id: string;
  name: string;
  params: unknown;
}>;

/** Accepted hosted text generation plus an opaque adapter-local continuation. */
export type HostedTextResult = Readonly<{
  text: unknown;
  toolCalls: ReadonlyArray<HostedTextToolCall>;
  finishReason: Response.FinishReason;
  usage: HostedTextUsage;
  continuation: HostedTextContinuation;
}>;

/**
 * Provider implementation of complete hosted-text preparation and execution. `prepare` must build
 * and capacity-check the exact complete provider request; `execute` must submit that request
 * unchanged. A successful execution returns the provider continuation represented by that request.
 */
export type HostedInferenceAdapter<Request, Continuation> = Readonly<{
  /** Counts one provider-compatible canonical plain-text aggregate without network I/O. */
  countText: (text: string) => Effect.Effect<number>;
  /** Counts an exact semantic Transcript projection with provider-owned framing. */
  countTranscript: (entries: ReadonlyArray<TranscriptEntry>) => Effect.Effect<number>;
  prepare: (
    input: Readonly<{
      basePrefix: ReadonlyArray<Prompt.MessageEncoded>;
      projection: HostedTextProjection;
      continuation: Option.Option<Continuation>;
    }> &
      HostedTextToolPolicy
  ) => Effect.Effect<Request, HostedInferenceError>;
  execute: (
    request: Request
  ) => Effect.Effect<
    Readonly<{ result: Omit<HostedTextResult, "continuation">; continuation: Continuation }>,
    HostedInferenceError
  >;
  structured: HostedStructuredAdapter;
}>;

/** Adapter-private executable retaining one exact request and its matching output decoder. */
export type PreparedStructuredExecution<Output> = Readonly<{
  execute: Effect.Effect<Output, HostedInferenceError>;
}>;

/** Provider implementation of exact strict structured preparation. */
export type HostedStructuredAdapter = Readonly<{
  prepare: <Output, Encoded extends Readonly<Record<string, unknown>>>(
    input: Readonly<{
      projection: HostedStructuredProjection;
      objectName: HostedStructuredObjectName;
      outputSchema: Schema.Codec<Output, Encoded, never, never>;
    }>
  ) => Effect.Effect<PreparedStructuredExecution<Output>, HostedInferenceError>;
}>;

/** Provider-neutral authority interface shared by live turns and startup validation. */
export type HostedInferenceService = Readonly<{
  /** Counts one canonical plain-text aggregate using provider-owned tokenization. */
  countText: (text: string) => Effect.Effect<number>;
  /** Counts exact semantic Transcript messages using provider-owned tokenization and framing. */
  countTranscript: (entries: ReadonlyArray<TranscriptEntry>) => Effect.Effect<number>;
  /** Claims the semantic context and returns a one-shot authority for its exact complete request. */
  prepareText: (
    request: HostedTextRequest
  ) => Effect.Effect<PreparedHostedText, HostedInferenceError>;
  /** Claims, prepares, and capacity-checks a request without creating executable authority. */
  validateText: (request: HostedTextRequest) => Effect.Effect<void, HostedInferenceError>;
  /**
   * Claims semantic input once and stores one exact strict request with its matching decoder.
   * Invalid or already-claimed context fails without producing an authority.
   */
  prepareStructured: <Output, Encoded extends Readonly<Record<string, unknown>>>(
    request: HostedStructuredRequest<Output, Encoded>
  ) => Effect.Effect<PreparedHostedStructured<Output>, HostedInferenceError>;
}>;

type PreparedLifecycle = "ready" | "executing" | "recoverable" | "consumed";
type ContinuationLifecycle = "ready" | "preparing" | "consumed";
type ContinuationState<Continuation> = {
  lifecycle: ContinuationLifecycle;
  continuation: Option.Option<Continuation>;
  basePrefix: ReadonlyArray<Prompt.MessageEncoded>;
};
type ExactPreparation<Continuation> = Readonly<{
  basePrefix: ReadonlyArray<Prompt.MessageEncoded>;
  projection: HostedTextProjection;
  continuation: Option.Option<Continuation>;
  policy: HostedTextToolPolicy;
  source: Option.Option<ContinuationState<Continuation>>;
}>;
type TextRuntime<Request, Continuation> = Readonly<{
  adapter: HostedInferenceAdapter<Request, Continuation>;
  prepareExact: (
    input: ExactPreparation<Continuation>
  ) => Effect.Effect<PreparedHostedText, HostedInferenceError>;
  makeContinuation: (
    basePrefix: ReadonlyArray<Prompt.MessageEncoded>,
    continuation: Option.Option<Continuation>
  ) => HostedTextContinuation;
}>;

const invalidAuthority = (): HostedInferenceError =>
  new HostedInferenceError({
    reason: { _tag: "InvalidAuthority" },
    retryable: false,
    retryAfter: Option.none(),
  });

const toolPolicy = (request: InitialHostedTextRequest): HostedTextToolPolicy =>
  request.toolChoice === "none"
    ? { toolChoice: "none" }
    : { toolChoice: "auto", maximumToolCalls: request.maximumToolCalls };

const prepareAdapterRequest = <Request, Continuation>(
  adapter: HostedInferenceAdapter<Request, Continuation>,
  input: ExactPreparation<Continuation>
): Effect.Effect<Request, HostedInferenceError> =>
  adapter.prepare(
    input.policy.toolChoice === "none"
      ? {
          basePrefix: input.basePrefix,
          projection: input.projection,
          continuation: input.continuation,
          toolChoice: "none",
        }
      : {
          basePrefix: input.basePrefix,
          projection: input.projection,
          continuation: input.continuation,
          toolChoice: "auto",
          maximumToolCalls: input.policy.maximumToolCalls,
        }
  );

const failedTextLifecycle = (exit: Exit.Exit<unknown, HostedInferenceError>): PreparedLifecycle => {
  if (!Exit.isFailure(exit)) return "ready";
  if (
    exit.cause.reasons.some(
      (reason) => reason._tag === "Fail" && reason.error.reason._tag === "InvalidOutput"
    )
  ) {
    return "recoverable";
  }
  return exit.cause.reasons.some(
    (reason) =>
      reason._tag === "Fail" &&
      reason.error.reason._tag === "ProviderUnavailable" &&
      reason.error.retryable
  )
    ? "ready"
    : "consumed";
};

const makePreparedText = <Request, Continuation>(
  runtime: TextRuntime<Request, Continuation>,
  exactRequest: Request,
  input: ExactPreparation<Continuation>
): PreparedHostedText => {
  let lifecycle: PreparedLifecycle = "ready";
  const consumeSource = (): void => {
    if (Option.isSome(input.source)) input.source.value.lifecycle = "consumed";
  };
  const execute = Effect.suspend(() => {
    if (lifecycle !== "ready") return Effect.fail(invalidAuthority());
    lifecycle = "executing";
    return runtime.adapter.execute(exactRequest).pipe(
      Effect.map(({ result, continuation }) => {
        lifecycle = "consumed";
        consumeSource();
        return {
          ...result,
          continuation: runtime.makeContinuation(input.basePrefix, Option.some(continuation)),
        };
      }),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (Exit.isFailure(exit)) lifecycle = failedTextLifecycle(exit);
        })
      )
    );
  });
  const recover = Effect.suspend(() => {
    if (lifecycle !== "recoverable") return Effect.fail(invalidAuthority());
    lifecycle = "consumed";
    consumeSource();
    return Effect.succeed(runtime.makeContinuation(input.basePrefix, Option.none()));
  });
  const discard = Effect.suspend(() => {
    if (lifecycle !== "ready" && lifecycle !== "recoverable") {
      return Effect.fail(invalidAuthority());
    }
    lifecycle = "consumed";
    consumeSource();
    return Effect.void;
  });
  const behavior = Fn.cast<object, PreparedHostedText>({});
  Object.defineProperties(behavior, {
    execute: { enumerable: false, value: execute },
    recover: { enumerable: false, value: recover },
    discard: { enumerable: false, value: discard },
  });
  return Object.freeze(behavior);
};

const prepareContinuation = <Request, Continuation>(
  runtime: TextRuntime<Request, Continuation>,
  state: ContinuationState<Continuation>,
  next: Readonly<{ context: HostedTextContext; policy: HostedTextToolPolicy }>
): Effect.Effect<PreparedHostedText, HostedInferenceError> =>
  Effect.suspend(() => {
    if (state.lifecycle !== "ready") return Effect.fail(invalidAuthority());
    const projection = claimHostedContext<HostedTextProjection>(next.context);
    if (Option.isNone(projection)) return Effect.fail(invalidAuthority());
    state.lifecycle = "preparing";
    return runtime
      .prepareExact({
        basePrefix: state.basePrefix,
        projection: projection.value,
        continuation: state.continuation,
        policy: next.policy,
        source: Option.some(state),
      })
      .pipe(
        Effect.onExit((exit) =>
          Effect.sync(() => {
            if (Exit.isFailure(exit)) state.lifecycle = "ready";
          })
        )
      );
  });

const makeContinuation = <Request, Continuation>(
  runtime: TextRuntime<Request, Continuation>,
  basePrefix: ReadonlyArray<Prompt.MessageEncoded>,
  continuation: Option.Option<Continuation>
): HostedTextContinuation => {
  const state: ContinuationState<Continuation> = {
    lifecycle: "ready",
    continuation,
    basePrefix,
  };
  return Object.freeze({
    prepare: (context, policy) => prepareContinuation(runtime, state, { context, policy }),
  });
};

type ClaimedInitial = Readonly<{
  projection: HostedTextProjection;
  policy: HostedTextToolPolicy;
}>;
const claimWorkingProjection = (
  context: WorkingContext | HostedTextContext
): Option.Option<HostedTextProjection> =>
  "startedAt" in context ? claimWorkingContext(context) : Option.none();

const claimInitialProjection = (
  context: WorkingContext | HostedTextContext
): Option.Option<HostedTextProjection> =>
  Object.getPrototypeOf(context) === hostedContextAuthorityPrototype
    ? claimHostedContext(context)
    : claimWorkingProjection(context);

const claimInitial = (
  request: InitialHostedTextRequest
): Effect.Effect<ClaimedInitial, HostedInferenceError> =>
  Effect.suspend(() => {
    const projection = claimInitialProjection(request.context);
    return Option.isNone(projection)
      ? Effect.fail(invalidAuthority())
      : Effect.succeed({ projection: projection.value, policy: toolPolicy(request) });
  });

const initialPreparation: <Continuation>(
  claimed: ClaimedInitial
) => ExactPreparation<Continuation> = (claimed) => ({
  basePrefix: claimed.projection.prefix,
  projection: { ...claimed.projection, prefix: [] },
  continuation: Option.none(),
  policy: claimed.policy,
  source: Option.none(),
});

const makeTextRuntime = <Request, Continuation>(
  adapter: HostedInferenceAdapter<Request, Continuation>
): Pick<HostedInferenceService, "prepareText" | "validateText"> => {
  const runtime: TextRuntime<Request, Continuation> = {
    adapter,
    prepareExact: (input) =>
      prepareAdapterRequest(adapter, input).pipe(
        Effect.map((request) => makePreparedText(runtime, freezeDeep(request), input))
      ),
    makeContinuation: (basePrefix, continuation) =>
      makeContinuation(runtime, basePrefix, continuation),
  };
  const prepareInitial = (
    request: InitialHostedTextRequest
  ): Effect.Effect<PreparedHostedText, HostedInferenceError> =>
    claimInitial(request).pipe(
      Effect.flatMap((claimed) => runtime.prepareExact(initialPreparation(claimed)))
    );
  const validateInitial = (
    request: InitialHostedTextRequest
  ): Effect.Effect<void, HostedInferenceError> =>
    claimInitial(request).pipe(
      Effect.flatMap((claimed) => prepareAdapterRequest(adapter, initialPreparation(claimed))),
      Effect.asVoid
    );
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

const makeStructuredBehavior = <Output extends unknown>(
  execution: PreparedStructuredExecution<Output>,
  outputSchema: Schema.Codec<Output, Readonly<Record<string, unknown>>, never, never>
): PreparedHostedStructured<Output> => {
  let state: "ready" | "executing" | "consumed" = "ready";
  const execute = Effect.suspend(() => {
    if (state !== "ready") return Effect.fail(invalidAuthority());
    state = "executing";
    return execution.execute.pipe(
      Effect.flatMap(Schema.encodeUnknownEffect(outputSchema)),
      Effect.flatMap((output) =>
        Schema.decodeUnknownEffect(outputSchema)(output).pipe(
          Effect.mapError(invalidStructuredOutput)
        )
      ),
      Effect.mapError((error) =>
        error instanceof HostedInferenceError ? error : invalidStructuredOutput()
      ),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          state = isRetryableProviderFailure(exit) ? "ready" : "consumed";
        })
      )
    );
  });
  const discard = Effect.suspend(() => {
    if (state !== "ready") return Effect.fail(invalidAuthority());
    state = "consumed";
    return Effect.void;
  });
  const behavior = Fn.cast<object, PreparedHostedStructured<Output>>({});
  Object.defineProperties(behavior, {
    execute: { enumerable: false, value: execute },
    discard: { enumerable: false, value: discard },
  });
  return Object.freeze(behavior);
};

const makeHostedStructuredRuntime = (
  adapter: HostedStructuredAdapter
): HostedStructuredRuntime => ({
  prepareStructured: <Output, Encoded extends Readonly<Record<string, unknown>>>(
    request: HostedStructuredRequest<Output, Encoded>
  ) =>
    Effect.suspend(() => {
      const projection = claimHostedContext<HostedStructuredProjection>(request.context);
      if (Option.isNone(projection)) return Effect.fail(invalidAuthority());
      return adapter
        .prepare({ ...request, projection: projection.value })
        .pipe(Effect.map((execution) => makeStructuredBehavior(execution, request.outputSchema)));
    }),
});

/**
 * Gives one adapter exclusive, one-shot ownership of its prepared requests and continuations.
 * Authorities from another returned service are rejected.
 */
export const makeHostedInference = <Request, Continuation>(
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

/** Hosted inference seam acquired by orchestration and startup validation. */
export class HostedInference extends Context.Service<HostedInference, HostedInferenceService>()(
  "@fidy/server/shell/agent/hosted-inference/HostedInference"
) {}
