import { Context, Data, Effect, Exit, Option, Schema } from "effect";
import type { Duration } from "effect";
import type { Prompt, Response } from "effect/unstable/ai";

const hostedTextContextNominal = Symbol("HostedTextContext");
const hostedStructuredContextNominal = Symbol("HostedStructuredContext");
const preparedHostedTextNominal = Symbol("PreparedHostedText");
const preparedHostedStructuredNominal = Symbol("PreparedHostedStructured");
const preparedHostedStructuredSchema = Symbol("PreparedHostedStructuredSchema");
const hostedTextContinuationNominal = Symbol("HostedTextContinuation");

/** Opaque, single-claim semantic context that may be projected only by HostedInference. */
export type HostedTextContext = Readonly<{ [hostedTextContextNominal]: true }>;

/** Opaque adapter-local authority for one exact prepared provider request. */
export type PreparedHostedText = Readonly<{ [preparedHostedTextNominal]: true }>;

/** Opaque, single-claim semantic context for one structured generation. */
export type HostedStructuredContext = Readonly<{ [hostedStructuredContextNominal]: true }>;

/** Opaque adapter-local authority bound to one schema-validated structured result. */
export type PreparedHostedStructured<Output> = Readonly<{
  [preparedHostedStructuredNominal]: true;
  [preparedHostedStructuredSchema]: Schema.ConstraintDecoder<Output>;
}>;

/** Opaque adapter-local continuation returned by successful hosted text execution. */
export type HostedTextContinuation = Readonly<{ [hostedTextContinuationNominal]: true }>;

/** Semantic prompt sections around provider-owned continuation items. @internal */
export type HostedTextProjection = Readonly<{
  prefix: ReadonlyArray<Prompt.MessageEncoded>;
  continuationTail: ReadonlyArray<Prompt.MessageEncoded>;
  suffix: ReadonlyArray<Prompt.MessageEncoded>;
}>;

/** Semantic messages claimable once by HostedInference for structured generation. @internal */
export type HostedStructuredProjection = Readonly<{
  messages: ReadonlyArray<Prompt.MessageEncoded>;
}>;

const contextProjections = new WeakMap<object, HostedTextProjection>();
const structuredContextProjections = new WeakMap<object, HostedStructuredProjection>();

const freezeDeep: <A>(value: A) => A = (value) => {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
};

/**
 * Compatibility projector used until WorkingContext owns construction in #205. The returned value
 * exposes no prompt data and can be claimed exactly once by one HostedInference adapter.
 *
 * @internal
 */
export const makeHostedTextContext = (projection: HostedTextProjection): HostedTextContext => {
  const authority: HostedTextContext = Object.freeze({ [hostedTextContextNominal]: true });
  const isolated: HostedTextProjection = structuredClone(projection);
  contextProjections.set(authority, freezeDeep(isolated));
  return authority;
};

/**
 * Isolates structured prompt messages behind a single-claim authority. The returned context exposes
 * no message data and exactly one HostedInference service may claim its projection.
 *
 * @internal
 */
// Structured workflow integration belongs to #206; adapter behavior is covered at its stable seam.
/* istanbul ignore next */
export const makeHostedStructuredContext = (
  projection: HostedStructuredProjection
): HostedStructuredContext => {
  const authority: HostedStructuredContext = Object.freeze({
    [hostedStructuredContextNominal]: true,
  });
  structuredContextProjections.set(authority, freezeDeep(structuredClone(projection)));
  return authority;
};

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
export type HostedTextRequest = Readonly<{
  context: HostedTextContext;
  continuation: Option.Option<HostedTextContinuation>;
}> &
  HostedTextToolPolicy;

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
  countMemoryText: (text: string) => Effect.Effect<number>;
  prepare: (
    input: Readonly<{
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
  /** Counts Memory's canonical plain-text aggregate using provider-owned tokenization. */
  countMemoryText: (text: string) => Effect.Effect<number>;
  /** Claims the semantic context and returns a one-shot authority for its exact complete request. */
  prepareText: (
    request: HostedTextRequest
  ) => Effect.Effect<PreparedHostedText, HostedInferenceError>;
  /** Claims, prepares, and capacity-checks a request without creating executable authority. */
  validateText: (request: HostedTextRequest) => Effect.Effect<void, HostedInferenceError>;
  /** Executes the unchanged prepared request; failure leaves it retryable until discarded. */
  executeText: (
    prepared: PreparedHostedText
  ) => Effect.Effect<HostedTextResult, HostedInferenceError>;
  /** Releases an unexecuted or terminally failed request and its claimed source continuation. */
  discardText: (prepared: PreparedHostedText) => Effect.Effect<void, HostedInferenceError>;
  /**
   * Claims semantic input once and stores one exact strict request with its matching decoder.
   * Invalid or already-claimed context fails without producing an authority.
   */
  prepareStructured: <Output, Encoded extends Readonly<Record<string, unknown>>>(
    request: HostedStructuredRequest<Output, Encoded>
  ) => Effect.Effect<PreparedHostedStructured<Output>, HostedInferenceError>;
  /**
   * Executes once and returns validated domain output. Retryable provider failure preserves the
   * authority; success, concurrent use, interruption, terminal failure, and invalid authority do not.
   */
  executeStructured: <Output>(
    prepared: PreparedHostedStructured<Output>
  ) => Effect.Effect<Output, HostedInferenceError>;
  /**
   * Releases an unexecuted authority. Foreign, discarded, executing, or already-consumed authority
   * fails without affecting another request.
   */
  discardStructured: <Output>(
    prepared: PreparedHostedStructured<Output>
  ) => Effect.Effect<void, HostedInferenceError>;
}>;

type PreparedEntry<Request, Continuation> = {
  request: Request;
  executing: boolean;
  sourceContinuation: Option.Option<
    Readonly<{
      authority: HostedTextContinuation;
      entry: ContinuationEntry<Continuation>;
    }>
  >;
};
type ContinuationEntry<Continuation> = { continuation: Continuation; preparing: boolean };

const invalidAuthority = (): HostedInferenceError =>
  new HostedInferenceError({
    reason: { _tag: "InvalidAuthority" },
    retryable: false,
    retryAfter: Option.none(),
  });

type Completion<Request, Continuation> = Readonly<{
  authority: PreparedHostedText;
  entry: PreparedEntry<Request, Continuation>;
  continuation: Continuation;
  result: Omit<HostedTextResult, "continuation">;
}>;

type ClaimedPreparation<Continuation> = Readonly<{
  projection: HostedTextProjection;
  continuation: Option.Option<Continuation>;
  continuationEntry: Option.Option<ContinuationEntry<Continuation>>;
}>;

type HostedInferenceState<Request, Continuation> = Readonly<{
  adapter: HostedInferenceAdapter<Request, Continuation>;
  prepared: WeakMap<object, PreparedEntry<Request, Continuation>>;
  continuations: WeakMap<object, ContinuationEntry<Continuation>>;
}>;

type HostedInferenceRuntime = Readonly<{
  prepare: (
    request: HostedTextRequest,
    executable: boolean
  ) => Effect.Effect<Option.Option<PreparedHostedText>, HostedInferenceError>;
  execute: (authority: PreparedHostedText) => Effect.Effect<HostedTextResult, HostedInferenceError>;
  discard: (authority: PreparedHostedText) => Effect.Effect<void, HostedInferenceError>;
}>;

const beginPreparation = <Request, Continuation>(
  state: HostedInferenceState<Request, Continuation>,
  request: HostedTextRequest
): Effect.Effect<ClaimedPreparation<Continuation>, HostedInferenceError> =>
  Effect.suspend(() => {
    const projection = contextProjections.get(request.context);
    if (projection === undefined) return Effect.fail(invalidAuthority());
    contextProjections.delete(request.context);
    if (Option.isNone(request.continuation)) {
      return Effect.succeed({
        projection,
        continuation: Option.none(),
        continuationEntry: Option.none(),
      });
    }
    const entry = state.continuations.get(request.continuation.value);
    if (entry === undefined || entry.preparing) return Effect.fail(invalidAuthority());
    entry.preparing = true;
    return Effect.succeed({
      projection,
      continuation: Option.some(entry.continuation),
      continuationEntry: Option.some(entry),
    });
  });

const releaseFailedClaim: <Continuation>(
  exit: Exit.Exit<unknown, unknown>,
  claimed: ClaimedPreparation<Continuation>
) => Effect.Effect<void> = (exit, claimed) =>
  Exit.match(exit, {
    onFailure: () =>
      Option.match(claimed.continuationEntry, {
        onNone: () => Effect.void,
        onSome: (entry) =>
          Effect.sync(() => {
            entry.preparing = false;
          }),
      }),
    onSuccess: () => Effect.void,
  });

const completeExecution = <Request, Continuation>(
  state: HostedInferenceState<Request, Continuation>,
  completion: Completion<Request, Continuation>
): HostedTextResult => {
  state.prepared.delete(completion.authority);
  if (Option.isSome(completion.entry.sourceContinuation)) {
    state.continuations.delete(completion.entry.sourceContinuation.value.authority);
  }
  const continuationAuthority: HostedTextContinuation = Object.freeze({
    [hostedTextContinuationNominal]: true,
  });
  state.continuations.set(continuationAuthority, {
    continuation: completion.continuation,
    preparing: false,
  });
  return { ...completion.result, continuation: continuationAuthority };
};

const prepareRequest = <Request, Continuation>(
  state: HostedInferenceState<Request, Continuation>,
  request: HostedTextRequest,
  executable: boolean
): Effect.Effect<Option.Option<PreparedHostedText>, HostedInferenceError> =>
  Effect.gen(function* () {
    const claimed = yield* beginPreparation(state, request);
    const semanticInput = {
      projection: claimed.projection,
      continuation: claimed.continuation,
    };
    const prepared = yield* state.adapter
      .prepare(
        request.toolChoice === "none"
          ? { ...semanticInput, toolChoice: request.toolChoice }
          : {
              ...semanticInput,
              toolChoice: request.toolChoice,
              maximumToolCalls: request.maximumToolCalls,
            }
      )
      .pipe(Effect.onExit((exit) => releaseFailedClaim(exit, claimed)));
    if (!executable) {
      if (Option.isSome(request.continuation)) {
        state.continuations.delete(request.continuation.value);
      }
      return Option.none();
    }
    const authority: PreparedHostedText = Object.freeze({
      [preparedHostedTextNominal]: true,
    });
    state.prepared.set(authority, {
      request: freezeDeep(prepared),
      executing: false,
      sourceContinuation: Option.all({
        authority: request.continuation,
        entry: claimed.continuationEntry,
      }),
    });
    return Option.some(authority);
  });

const executeRequest = <Request, Continuation>(
  state: HostedInferenceState<Request, Continuation>,
  authority: PreparedHostedText
): Effect.Effect<HostedTextResult, HostedInferenceError> =>
  Effect.suspend(() => {
    const entry = state.prepared.get(authority);
    if (entry === undefined || entry.executing) return Effect.fail(invalidAuthority());
    entry.executing = true;
    return state.adapter.execute(entry.request).pipe(
      Effect.map(({ continuation, result }) =>
        completeExecution(state, { authority, entry, continuation, result })
      ),
      Effect.onExit((exit) => {
        if (Exit.isFailure(exit)) entry.executing = false;
        return Effect.void;
      })
    );
  });

const discardRequest = <Request, Continuation>(
  state: HostedInferenceState<Request, Continuation>,
  authority: PreparedHostedText
): Effect.Effect<void, HostedInferenceError> =>
  Effect.suspend(() => {
    const entry = state.prepared.get(authority);
    if (entry === undefined || entry.executing) return Effect.fail(invalidAuthority());
    state.prepared.delete(authority);
    if (Option.isSome(entry.sourceContinuation)) {
      entry.sourceContinuation.value.entry.preparing = false;
    }
    return Effect.void;
  });

const makeHostedInferenceRuntime = <Request, Continuation>(
  adapter: HostedInferenceAdapter<Request, Continuation>
): HostedInferenceRuntime => {
  const state: HostedInferenceState<Request, Continuation> = {
    adapter,
    prepared: new WeakMap(),
    continuations: new WeakMap(),
  };
  return {
    prepare: (request, executable) => prepareRequest(state, request, executable),
    execute: (authority) => executeRequest(state, authority),
    discard: (authority) => discardRequest(state, authority),
  };
};

type HostedStructuredRuntime = Pick<
  HostedInferenceService,
  "prepareStructured" | "executeStructured" | "discardStructured"
>;

/* istanbul ignore next */
const invalidStructuredOutput = (): HostedInferenceError =>
  new HostedInferenceError({
    reason: {
      _tag: "InvalidOutput",
      description: "Hosted structured output was malformed",
    },
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

type PreparedStructuredEntry = {
  executing: boolean;
  execute: Effect.Effect<unknown, HostedInferenceError>;
};

/* istanbul ignore next */
const storeStructuredExecution = function <Output>(
  prepared: WeakMap<object, PreparedStructuredEntry>,
  execution: PreparedStructuredExecution<Output>,
  outputSchema: Schema.Codec<Output, Readonly<Record<string, unknown>>, never, never>
): PreparedHostedStructured<Output> {
  const authority = {
    [preparedHostedStructuredNominal]: true as const,
    // This non-enumerable type witness is caller-owned domain schema, never provider state.
    [preparedHostedStructuredSchema]: outputSchema,
  };
  Object.defineProperties(authority, {
    [preparedHostedStructuredNominal]: { enumerable: false },
    [preparedHostedStructuredSchema]: { enumerable: false },
  });
  Object.freeze(authority);
  prepared.set(authority, {
    executing: false,
    execute: execution.execute.pipe(
      Effect.flatMap(Schema.encodeUnknownEffect(outputSchema)),
      Effect.mapError((error) =>
        error instanceof HostedInferenceError ? error : invalidStructuredOutput()
      )
    ),
  });
  return authority;
};

/* istanbul ignore next */
const makeHostedStructuredRuntime = (adapter: HostedStructuredAdapter): HostedStructuredRuntime => {
  const prepared = new WeakMap<object, PreparedStructuredEntry>();
  return {
    prepareStructured: <Output, Encoded extends Readonly<Record<string, unknown>>>(
      request: HostedStructuredRequest<Output, Encoded>
    ) =>
      Effect.suspend(() => {
        const projection = structuredContextProjections.get(request.context);
        if (projection === undefined) return Effect.fail(invalidAuthority());
        structuredContextProjections.delete(request.context);
        return adapter
          .prepare({ ...request, projection })
          .pipe(
            Effect.map((execution) =>
              storeStructuredExecution(prepared, execution, request.outputSchema)
            )
          );
      }),
    executeStructured: (authority) =>
      Effect.suspend(() => {
        const entry = prepared.get(authority);
        if (entry === undefined || entry.executing) return Effect.fail(invalidAuthority());
        entry.executing = true;
        return entry.execute.pipe(
          Effect.flatMap((output) =>
            Schema.decodeUnknownEffect(authority[preparedHostedStructuredSchema])(output).pipe(
              Effect.mapError(invalidStructuredOutput)
            )
          ),
          Effect.onExit((exit) =>
            Effect.sync(() => {
              if (isRetryableProviderFailure(exit)) entry.executing = false;
              else prepared.delete(authority);
            })
          )
        );
      }),
    discardStructured: (authority) =>
      Effect.suspend(() => {
        const entry = prepared.get(authority);
        if (entry === undefined || entry.executing) return Effect.fail(invalidAuthority());
        prepared.delete(authority);
        return Effect.void;
      }),
  };
};

/**
 * Gives one adapter exclusive, one-shot ownership of its prepared requests and continuations.
 * Authorities from another returned service are rejected.
 */
export const makeHostedInference = <Request, Continuation>(
  adapter: HostedInferenceAdapter<Request, Continuation>
): HostedInferenceService => {
  const runtime = makeHostedInferenceRuntime(adapter);
  const structuredRuntime = makeHostedStructuredRuntime(adapter.structured);
  return {
    countMemoryText: adapter.countMemoryText,
    prepareText: (request) =>
      runtime.prepare(request, true).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.die("Executable preparation did not create an authority"),
            onSome: Effect.succeed,
          })
        )
      ),
    validateText: (request) => runtime.prepare(request, false).pipe(Effect.asVoid),
    executeText: (authority) => runtime.execute(authority),
    discardText: (authority) => runtime.discard(authority),
    ...structuredRuntime,
  };
};

/** Hosted inference seam acquired by orchestration and startup validation. */
export class HostedInference extends Context.Service<HostedInference, HostedInferenceService>()(
  "fidy-ai/shell/agent/hosted-inference/HostedInference"
) {}
