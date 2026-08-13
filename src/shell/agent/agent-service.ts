import {
  Cause,
  Clock,
  Context,
  Crypto,
  Data,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Random,
  Result,
  Schema,
  Stream,
  Struct,
} from "effect";
import type { Tool } from "effect/unstable/ai";
import { HttpClient } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import type { User } from "~/core/identity/model";
import type { UserId } from "~/core/identity/reference";
import { CompactedConversationOutput } from "~/core/transcript/compacted-conversation";
import {
  ConversationCompactionInference,
  ConversationCompactionInferenceError,
} from "~/shell/transcript/conversation-compaction-inference";
import {
  AgentIteration,
  type CanonicalToolOutcome,
  ToolCallId,
  TranscriptText,
} from "~/core/transcript/model";
import { ValidationFailed } from "~/shell/_shared/errors";
import { useCurrentConsent } from "~/shell/consent/repo";
import { findUser } from "~/shell/identity/repo";
import {
  type DeclaredOutcome,
  type SpanDescriptor,
  TelemetryAttempt,
  type TelemetryBreadcrumb,
  TelemetryCount,
  TelemetryDuration,
  maximumTelemetryCount,
} from "~/shell/observability/protocol";
import { Telemetry, type TelemetryService } from "~/shell/observability/telemetry";
import { atomicBatchOperation } from "~/shell/operations/operations";
import { issueHostedAgentToken, revokeHostedAgentToken } from "~/shell/tokens/hosted-agent-token";
import {
  type ContinuityChanged,
  ConversationContinuity,
  type PendingTurn,
  type PreparedAttempt,
  type SerializedAttempt,
  type TurnContinuationContent,
} from "~/shell/transcript/conversation-continuity";
import {
  containsSensitiveChatValue,
  containsSensitiveJson,
  credentialRejectedReply,
  exactTranscriptPrompt,
  sensitiveEntryRejected,
  type transcriptPrompt,
} from "./model-boundary";
import {
  HostedInference,
  HostedInferenceError,
  type HostedInferenceService,
  HostedStructuredObjectName,
  type HostedTextContinuation,
  type HostedTextResult,
  HostedToolCallMaximum,
  type PreparedHostedText,
  makeHostedStructuredContext,
  makeHostedTextContext,
} from "./hosted-inference";
import { type WorkingContext, makeWorkingContext } from "./working-context";
import { makeTurnConfirmation } from "./tool-confirmation";
import { renderTransactionReceipt } from "./transaction-receipt";
import {
  type AgentOperationBinding,
  agentOperationBindings,
  decodeAgentOperationInput,
  findAgentOperationBinding,
  makeAgentToolkit,
} from "./toolkit";

const attemptWindowMillis = 250;
const modelRetryPolicy = {
  maximumAttempts: 2,
  minimumAttemptWindow: Duration.millis(attemptWindowMillis),
  fallbackDelay: Duration.millis(100),
  jitterWindow: Duration.millis(100),
} as const;
const turnDescriptor: SpanDescriptor = {
  component: "agent",
  operation: "agent.hostedTurn",
  trigger: "api",
  spanOperation: "agent.turn",
  workKind: "hosted_turn",
  metadata: { _tag: "None" },
};
const modelRoundDescriptor: SpanDescriptor = {
  component: "agent",
  operation: "agent.modelRound",
  trigger: "api",
  spanOperation: "agent.model",
  workKind: "model_call",
  metadata: { _tag: "Model", model: "hosted_inference" },
};

/** Resource and context bounds applied independently to every hosted turn. */
export const AgentLimits = Schema.Struct({
  maxIterations: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
  maxToolCallsPerTurn: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
  maxToolResultCharacters: Schema.Int.check(
    Schema.isBetween({ minimum: 1_000, maximum: 1_000_000 })
  ),
  maxModelRoundMillis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 120_000 })),
});
export type AgentLimits = typeof AgentLimits.Type;

/** Default launch bounds; tests may override this reference at the public seam. */
export const CurrentAgentLimits = Context.Reference<AgentLimits>(
  "fidy-ai/shell/agent/agent-service/CurrentAgentLimits",
  {
    defaultValue: () =>
      AgentLimits.make({
        maxIterations: 6,
        maxToolCallsPerTurn: 12,
        maxToolResultCharacters: 32_000,
        maxModelRoundMillis: 30_000,
      }),
  }
);

/** Channel-neutral text accepted by the hosted agent. */
export const InboundMessage = Schema.Struct({ text: TranscriptText });
export type InboundMessage = typeof InboundMessage.Type;

/** One channel-neutral media reference that an adapter may render or deliver. */
export const AgentAttachment = Schema.Struct({
  mediaType: Schema.NonEmptyString,
  url: Schema.URLFromString,
});
/** One channel-neutral follow-up action that an adapter may present to the User. */
export const AgentChoice = Schema.Struct({
  label: Schema.NonEmptyString,
  message: TranscriptText,
});
/** Semantic response returned to whichever channel initiated the turn. */
export const AgentReply = Schema.Struct({
  text: TranscriptText,
  attachments: Schema.OptionFromOptionalKey(Schema.NonEmptyArray(AgentAttachment)),
  choices: Schema.OptionFromOptionalKey(Schema.NonEmptyArray(AgentChoice)),
});
export type AgentReply = typeof AgentReply.Type;

/** Failure returned when no stable User and interpretation context exist. */
export class UnknownUser extends Data.TaggedError("UnknownUser")<{
  readonly userId: UserId;
}> {
  override get message(): string {
    return "No stable User and interpretation context exist for this turn";
  }
}

/** Failure returned before any model or transcript work when onboarding consent is absent. */
export class OnboardingConsentRequired extends Data.TaggedError("OnboardingConsentRequired")<{
  readonly userId: UserId;
}> {
  override get message(): string {
    return "The User has no current onboarding consent";
  }
}

/** Content-free failure when complete exact hosted context exceeds provider capacity. */
export class HostedCapacityExceeded extends Data.TaggedError("HostedCapacityExceeded")<{}> {
  override get message(): string {
    return "The complete exact hosted context exceeds provider capacity";
  }
}

/** Safe failure returned when the configured language model or provider cannot serve a turn. */
export class ModelUnavailable extends Data.TaggedError("ModelUnavailable")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return "The configured language model or provider could not serve the turn";
  }
}

/** Safe failure returned when model output cannot be accepted or executed. */
export class ModelResponseRejected extends Data.TaggedError("ModelResponseRejected")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return "The model response could not be accepted or executed";
  }
}

/** Closed failure vocabulary exposed by the channel-agnostic turn boundary. */
export type AgentTurnError =
  | UnknownUser
  | OnboardingConsentRequired
  | HostedCapacityExceeded
  | ModelUnavailable
  | ModelResponseRejected;

const withCurrentConsent = <A, E, R>(
  subjectUserId: UserId,
  use: Effect.Effect<A, E, R>
): Effect.Effect<A, E | OnboardingConsentRequired, R | SqlClient.SqlClient> =>
  Effect.flatMap(SqlClient.SqlClient, (sql) =>
    sql
      .withTransaction(
        useCurrentConsent(
          subjectUserId,
          () => Effect.fail(new OnboardingConsentRequired({ userId: subjectUserId })),
          use
        )
      )
      .pipe(Effect.catchTag("SqlError", Effect.die))
  );

const makeTextReply = (text: TranscriptText): AgentReply =>
  AgentReply.make({ text, attachments: Option.none(), choices: Option.none() });

const operationCompletedReply = TranscriptText.make("Listo, completé la operación solicitada.");
const makeCompletedReply = ({
  binding,
  output,
  turnStartedAt,
  user,
}: Readonly<{
  binding: AgentOperationBinding;
  output: Schema.Json;
  turnStartedAt: DateTime.Utc;
  user: User;
}>): TranscriptText =>
  binding.operation === "transactions.createTransaction"
    ? Option.getOrElse(
        renderTransactionReceipt({
          locale: user.locale,
          output,
          timeZone: user.timeZone,
          turnStartedAt,
        }),
        () => operationCompletedReply
      )
    : operationCompletedReply;
const exhaustedReply = TranscriptText.make(
  "No pude completar la solicitud dentro del límite seguro de operaciones. Intenta de nuevo."
);
const CanonicalValidationFailure = ValidationFailed.mapFields(Struct.pick(["error"]));

const modelResponseRejected = (cause: unknown): ModelResponseRejected =>
  new ModelResponseRejected({ cause });
const decodeTranscriptText = (
  value: unknown
): Effect.Effect<TranscriptText, ModelResponseRejected> =>
  Schema.decodeUnknownEffect(TranscriptText)(value).pipe(Effect.mapError(modelResponseRejected));
const decodeTranscriptJson = (value: unknown): Effect.Effect<Schema.Json, ModelResponseRejected> =>
  Schema.decodeUnknownEffect(Schema.Json)(value).pipe(Effect.mapError(modelResponseRejected));
const encodeTranscriptJson = (
  schema: Schema.Codec<unknown, unknown, never, never>,
  value: unknown
): Effect.Effect<Schema.Json, ModelResponseRejected> =>
  Schema.encodeUnknownEffect(schema)(value).pipe(
    Effect.flatMap(decodeTranscriptJson),
    Effect.mapError(modelResponseRejected)
  );
const encodeAgentOperationInput = (
  binding: AgentOperationBinding,
  input: unknown
): Effect.Effect<Schema.Json, ModelResponseRejected> =>
  encodeTranscriptJson(binding.canonicalParameters, input);
const requireToolResult = function <A>(
  result: Option.Option<A>
): Effect.Effect<never, ModelResponseRejected> | Effect.Effect<A> {
  return Option.match(result, {
    onNone: () => Effect.fail(modelResponseRejected(new Error("Tool result was missing"))),
    onSome: (value) => Effect.succeed(value),
  });
};
const isTerminalToolResult = (result: { readonly preliminary: boolean }): boolean =>
  result.preliminary === false;
const makeToolOutcome = (isFailure: boolean, result: Schema.Json): CanonicalToolOutcome => {
  if (!isFailure) return { _tag: "Succeeded", output: result };
  if (Schema.is(CanonicalValidationFailure)(result)) {
    return { _tag: "ToolInputRejected", failure: result };
  }
  return { _tag: "CanonicalOperationFailed", failure: result };
};

/**
 * A reply prepared for asynchronous delivery plus the metadata needed to record that exact reply.
 * The assistant text is deliberately derived from `reply` when delivery is recorded, so prepared
 * state cannot represent a different sent and persisted message.
 */
type PreparedAgentReply = Readonly<{
  reply: AgentReply;
  assistantEntry: Option.Option<Readonly<{ iteration: AgentIteration }>>;
}>;

const preparedReply = (
  reply: AgentReply,
  assistantEntry: PreparedAgentReply["assistantEntry"]
): PreparedAgentReply => ({ reply, assistantEntry });

type AgentToolkitInstance = Effect.Success<ReturnType<typeof makeAgentToolkit>>;

type AgentToolCall = Readonly<{
  id: string;
  name: Parameters<AgentToolkitInstance["handle"]>[0];
  params: unknown;
}>;

type HostedTurn = Readonly<{
  userId: UserId;
  user: User;
  startedAt: DateTime.Utc;
  limits: AgentLimits;
  confirmation: Effect.Success<ReturnType<typeof makeTurnConfirmation>>;
  toolkit: AgentToolkitInstance;
  pending: PendingTurn;
  continuationEntries: Array<TurnContinuationContent>;
  initialPrepared: PreparedHostedText;
}>;

type RecordedCall = Readonly<{
  binding: AgentOperationBinding;
  iteration: AgentIteration;
  toolCallId: ToolCallId;
}>;

type ToolCallOutcome =
  | Readonly<{ _tag: "Recorded" }>
  | Readonly<{ _tag: "TurnCompleted"; text: TranscriptText }>;

type GenerationResponse =
  | Readonly<{ _tag: "Completed"; text: TranscriptText }>
  | Readonly<{ _tag: "Continued" }>;

type AcceptedGeneration = Readonly<{
  text: unknown;
  toolCalls: ReadonlyArray<AgentToolCall>;
  finishReason: HostedTextResult["finishReason"];
  continuation: HostedTextContinuation;
}>;

type TurnModelContinuation = Option.Option<HostedTextContinuation>;

type ModelRoundDecision = Readonly<
  | { _tag: "Accepted"; generated: AcceptedGeneration }
  | {
      _tag: "Retry";
      feedback: string;
      continuation: Option.Option<HostedTextContinuation>;
    }
>;

const recordedToolCall: ToolCallOutcome = { _tag: "Recorded" };
const continuedGeneration: GenerationResponse = { _tag: "Continued" };

const safeReplyText = (text: TranscriptText): TranscriptText =>
  containsSensitiveChatValue(text) ? credentialRejectedReply : text;

const toolCallOutcome = (
  executed: Readonly<{ isFailure: boolean }>,
  result: Schema.Json
): CanonicalToolOutcome =>
  containsSensitiveJson(result)
    ? { _tag: "ToolOutputRejected", failure: sensitiveEntryRejected }
    : makeToolOutcome(executed.isFailure, result);

const completesTurn = (binding: AgentOperationBinding, outcome: CanonicalToolOutcome): boolean =>
  [
    binding.operation !== atomicBatchOperation,
    binding.policy.requiredScope === "write",
    outcome._tag === "Succeeded",
  ].every(Boolean);

const recordToolOutcome = Effect.fn("AgentService.recordToolOutcome")(function* (
  turn: HostedTurn,
  call: RecordedCall,
  outcome: CanonicalToolOutcome
) {
  const content: TurnContinuationContent = {
    _tag: "CanonicalToolResultEntry",
    iteration: call.iteration,
    toolCallId: call.toolCallId,
    operation: call.binding.operation,
    outcome,
  };
  yield* turn.pending.append([content]);
  turn.continuationEntries.push(content);
});

const recordToolCall = Effect.fn("AgentService.recordToolCall")(function* (
  turn: HostedTurn,
  call: RecordedCall,
  input: Schema.Json
) {
  const content: TurnContinuationContent = {
    _tag: "CanonicalToolCallEntry",
    iteration: call.iteration,
    toolCallId: call.toolCallId,
    operation: call.binding.operation,
    input,
  };
  yield* turn.pending.append([content]);
  turn.continuationEntries.push(content);
});

const runToolkitCall = (
  turn: HostedTurn,
  name: AgentToolCall["name"],
  input: Schema.Json
): Effect.Effect<
  Tool.HandlerResult<AgentToolkitInstance["tools"][AgentToolCall["name"]]>,
  ModelResponseRejected
> =>
  turn.toolkit
    .handle(name, input)
    .pipe(
      Stream.unwrap,
      Stream.filter(isTerminalToolResult),
      Stream.runLast,
      Effect.flatMap(requireToolResult),
      Effect.mapError(modelResponseRejected)
    );

const turnCompletedOutcome = (
  turn: HostedTurn,
  binding: AgentOperationBinding,
  output: Schema.Json
): ToolCallOutcome => ({
  _tag: "TurnCompleted",
  text: makeCompletedReply({ binding, output, turnStartedAt: turn.startedAt, user: turn.user }),
});

type PreparedToolCallBase = Readonly<{
  toolCall: AgentToolCall;
  call: RecordedCall;
  input: Schema.Json;
}>;

type PreparedToolCall =
  | (PreparedToolCallBase & Readonly<{ _tag: "Valid" }>)
  | (PreparedToolCallBase & Readonly<{ _tag: "Invalid" }>);

type ValidPreparedToolCall = Extract<PreparedToolCall, { readonly _tag: "Valid" }>;

type ConfirmationSettledToolCall = ValidPreparedToolCall &
  Readonly<{
    confirmation: Effect.Success<ReturnType<HostedTurn["confirmation"]["decide"]>>;
  }>;

const preflightRejected: Schema.Json = {
  code: "response_preflight_rejected",
  message:
    "Another operation in the same model response was malformed or requires confirmation. Correct the complete response before retrying.",
};
const atomicBatchRequired: Schema.Json = {
  code: "atomic_batch_required",
  message:
    `Multiple confirmation-required mutations must be proposed as one ${atomicBatchOperation} call. ` +
    "Put the exact ordered mutations in its calls payload and retry.",
};

const prepareAgentToolCall = Effect.fn("AgentService.prepareToolCall")(function* (
  iteration: AgentIteration,
  toolCall: AgentToolCall
) {
  const binding = yield* findAgentOperationBinding(toolCall.name).pipe(
    Option.match({
      onNone: () =>
        Effect.fail(modelResponseRejected(new Error("Model named an unknown operation"))),
      onSome: Effect.succeed,
    })
  );
  const encodedInput = yield* Effect.result(encodeAgentOperationInput(binding, toolCall.params));
  const input = yield* Result.match(encodedInput, {
    onFailure: () => decodeTranscriptJson(toolCall.params),
    onSuccess: Effect.succeed,
  });
  const carriesMemoryProse =
    binding.operation === "memory.remember" || binding.operation === "memory.revise";
  if (!carriesMemoryProse && containsSensitiveJson(input)) {
    return yield* modelResponseRejected(
      new Error("Model operation input contained a sensitive value")
    );
  }
  const prepared = {
    toolCall,
    call: { binding, iteration, toolCallId: ToolCallId.make(toolCall.id) },
    input,
  };
  return Result.isSuccess(encodedInput)
    ? ({ ...prepared, _tag: "Valid" } as const)
    : ({ ...prepared, _tag: "Invalid" } as const);
});

const recordRejectedPreflight = (
  turn: HostedTurn,
  calls: ReadonlyArray<PreparedToolCall>,
  failure: Schema.Json
): Effect.Effect<void, OnboardingConsentRequired, Crypto.Crypto | SqlClient.SqlClient> =>
  Effect.forEach(
    calls,
    ({ call }) =>
      recordToolOutcome(turn, call, {
        _tag: "ToolInputRejected",
        failure,
      }),
    { concurrency: 1, discard: true }
  );

const confirmationRequiredCount = (calls: ReadonlyArray<ValidPreparedToolCall>): number =>
  calls.filter(
    ({ call }) =>
      call.binding.operation !== atomicBatchOperation &&
      call.binding.policy.agentConfirmation === "required"
  ).length;

const requiresAtomicBatchCorrection = (calls: ReadonlyArray<ValidPreparedToolCall>): boolean => {
  const includesAtomicBatch = calls.some(
    ({ call }) => call.binding.operation === atomicBatchOperation
  );
  const mixesAtomicBatchWithSiblingCalls = [calls.length > 1, includesAtomicBatch].every(Boolean);
  return [confirmationRequiredCount(calls) > 1, mixesAtomicBatchWithSiblingCalls].some(Boolean);
};

const settleConfirmations = (
  turn: HostedTurn,
  calls: ReadonlyArray<ValidPreparedToolCall>
): Effect.Effect<
  ReadonlyArray<ConfirmationSettledToolCall>,
  never,
  Crypto.Crypto | SqlClient.SqlClient
> =>
  Effect.forEach(
    calls,
    (prepared) =>
      turn.confirmation
        .decide({ binding: prepared.call.binding, input: prepared.input })
        .pipe(Effect.map((confirmation) => ({ ...prepared, confirmation }))),
    { concurrency: 1 }
  );

const executePreparedToolCall = Effect.fn("AgentService.executePreparedToolCall")(function* (
  turn: HostedTurn,
  prepared: ValidPreparedToolCall
) {
  const executed = yield* runToolkitCall(turn, prepared.toolCall.name, prepared.input);
  const result = yield* decodeTranscriptJson(executed.encodedResult);
  const outcome = toolCallOutcome(executed, result);
  yield* recordToolOutcome(turn, prepared.call, outcome);
  if (!completesTurn(prepared.call.binding, outcome)) return recordedToolCall;
  return turnCompletedOutcome(turn, prepared.call.binding, result);
});

const prepareGeneratedCalls = Effect.fn("AgentService.prepareGeneratedCalls")(function* (
  turn: HostedTurn,
  iteration: AgentIteration,
  generated: AcceptedGeneration
) {
  const prepared = yield* Effect.forEach(
    generated.toolCalls,
    (toolCall) => prepareAgentToolCall(iteration, toolCall),
    { concurrency: 1 }
  );
  yield* Effect.forEach(prepared, ({ call, input }) => recordToolCall(turn, call, input), {
    concurrency: 1,
    discard: true,
  });
  return prepared;
});

const collectValidPreparedCalls = (
  prepared: ReadonlyArray<PreparedToolCall>
): Option.Option<ReadonlyArray<ValidPreparedToolCall>> => {
  const valid = prepared.filter((call): call is ValidPreparedToolCall => call._tag === "Valid");
  return valid.length === prepared.length ? Option.some(valid) : Option.none();
};

const acceptGeneratedCalls = Effect.fn("AgentService.acceptGeneratedCalls")(function* (
  turn: HostedTurn,
  prepared: ReadonlyArray<PreparedToolCall>
) {
  const valid = collectValidPreparedCalls(prepared);
  if (Option.isNone(valid)) {
    yield* recordRejectedPreflight(turn, prepared, preflightRejected);
    return Option.none();
  }
  if (requiresAtomicBatchCorrection(valid.value)) {
    yield* recordRejectedPreflight(turn, prepared, atomicBatchRequired);
    return Option.none();
  }
  return valid;
});

const settleGeneratedConfirmation = Effect.fn("AgentService.settleGeneratedConfirmation")(
  function* (turn: HostedTurn, prepared: ReadonlyArray<ValidPreparedToolCall>) {
    const settledCalls = yield* settleConfirmations(turn, prepared);
    const challenge = settledCalls.find(
      ({ confirmation }) => confirmation._tag === "RequireConfirmation"
    );
    if (challenge?.confirmation._tag !== "RequireConfirmation") return Option.none();
    yield* Effect.forEach(
      settledCalls,
      ({ call, confirmation }) =>
        recordToolOutcome(turn, call, {
          _tag: "ToolInputRejected",
          failure:
            confirmation._tag === "RequireConfirmation" ? confirmation.failure : preflightRejected,
        }),
      { concurrency: 1, discard: true }
    );
    return Option.some(challenge.confirmation.failure.challenge);
  }
);

const executeGeneratedCalls = Effect.fn("AgentService.executeGeneratedCalls")(function* (
  turn: HostedTurn,
  prepared: ReadonlyArray<ValidPreparedToolCall>
) {
  let completed = Option.none<TranscriptText>();
  for (const preparedCall of prepared) {
    const outcome = yield* executePreparedToolCall(turn, preparedCall);
    if (outcome._tag === "TurnCompleted") completed = Option.some(outcome.text);
  }
  return Option.match(completed, {
    onNone: (): GenerationResponse => continuedGeneration,
    onSome: (text): GenerationResponse => ({ _tag: "Completed", text }),
  });
});

const respondToGeneration = Effect.fn("AgentService.respondToGeneration")(function* (
  turn: HostedTurn,
  iteration: AgentIteration,
  generated: AcceptedGeneration
) {
  if (generated.finishReason !== "stop" && generated.finishReason !== "tool-calls") {
    return yield* modelResponseRejected(
      new Error(`Model generation stopped with ${generated.finishReason}`)
    );
  }
  if (generated.toolCalls.length === 0) {
    const decodedText = yield* decodeTranscriptText(generated.text);
    return { _tag: "Completed", text: safeReplyText(decodedText) } as const;
  }

  const prepared = yield* prepareGeneratedCalls(turn, iteration, generated);
  const accepted = yield* acceptGeneratedCalls(turn, prepared);
  if (Option.isNone(accepted)) return continuedGeneration;
  const challenge = yield* settleGeneratedConfirmation(turn, accepted.value);
  if (Option.isSome(challenge)) return { _tag: "Completed", text: challenge.value } as const;
  return yield* executeGeneratedCalls(turn, accepted.value);
});

const fallbackRetryDelay = Random.nextIntBetween(
  0,
  Duration.toMillis(modelRetryPolicy.jitterWindow)
).pipe(
  Effect.map((jitterMillis) =>
    Duration.millis(Duration.toMillis(modelRetryPolicy.fallbackDelay) + jitterMillis)
  )
);

type ModelGeneration = HostedTextResult;
type RecoverableHostedOutput = Readonly<{
  _tag: "RecoverableHostedOutput";
  failure: HostedInferenceError;
  continuation: HostedTextContinuation;
}>;
type ModelRoundFailure = HostedInferenceError | Cause.TimeoutError | RecoverableHostedOutput;

const retryBreadcrumb = (nextAttempt: number, delayMillis: number): TelemetryBreadcrumb => ({
  category: "agent",
  action: "retry_started",
  component: "agent",
  outcome: Option.none(),
  error: Option.none(),
  attempt: Option.some(TelemetryAttempt.make(nextAttempt)),
  durationMilliseconds: Option.some(TelemetryDuration.make(delayMillis)),
});

const recordModelCompletion = (
  telemetry: TelemetryService,
  attemptCount: number,
  outcome: DeclaredOutcome
): Effect.Effect<void> =>
  Effect.all([
    telemetry.addBreadcrumb({
      category: "agent",
      action: "model_completed",
      component: "agent",
      outcome: Option.some(outcome.outcome),
      error: outcome.error,
      attempt: Option.some(TelemetryAttempt.make(Math.max(1, attemptCount))),
      durationMilliseconds: Option.none(),
    }),
    telemetry.recordOutcome(outcome),
  ]).pipe(Effect.asVoid);

type ModelAttemptState = {
  attemptCount: number;
  retryDelayMillis: number;
};

const telemetryTokenCount = (value: Option.Option<number>): TelemetryCount =>
  TelemetryCount.make(
    Math.min(maximumTelemetryCount, Math.max(0, Math.trunc(Option.getOrElse(value, () => 0))))
  );

const recordModelUsage = (
  telemetry: TelemetryService,
  state: ModelAttemptState,
  generation: Option.Option<ModelGeneration>
): Effect.Effect<void> =>
  telemetry.recordModelUsage({
    attempt: TelemetryAttempt.make(Math.max(1, state.attemptCount)),
    inputTokens: telemetryTokenCount(Option.map(generation, ({ usage }) => usage.inputTokens)),
    outputTokens: telemetryTokenCount(Option.map(generation, ({ usage }) => usage.outputTokens)),
  });

const retryDelayFits = (delay: Duration.Duration, remainingMillis: number): boolean =>
  Duration.toMillis(delay) + Duration.toMillis(modelRetryPolicy.minimumAttemptWindow) <=
  remainingMillis;

const selectRetryDelay = (
  providerDelay: Option.Option<Duration.Duration>,
  remainingMillis: number
): Effect.Effect<Option.Option<Duration.Duration>> =>
  Effect.gen(function* () {
    if (Option.isSome(providerDelay) && retryDelayFits(providerDelay.value, remainingMillis)) {
      return providerDelay;
    }
    const fallbackDelay = yield* fallbackRetryDelay;
    return retryDelayFits(fallbackDelay, remainingMillis)
      ? Option.some(fallbackDelay)
      : Option.none();
  });

const executeModelAttempts = ({
  attempt,
  roundMillis,
  telemetry,
  state,
}: Readonly<{
  attempt: Effect.Effect<ModelGeneration, HostedInferenceError>;
  roundMillis: number;
  telemetry: TelemetryService;
  state: ModelAttemptState;
}>): Effect.Effect<Result.Result<ModelGeneration, HostedInferenceError>> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const deadline = startedAt + roundMillis;
    while (state.attemptCount < modelRetryPolicy.maximumAttempts) {
      state.attemptCount += 1;
      const attempted = yield* Effect.result(attempt);
      if (Result.isSuccess(attempted)) return attempted;
      if (
        attempted.failure.reason._tag !== "ProviderUnavailable" ||
        !attempted.failure.retryable ||
        state.attemptCount === modelRetryPolicy.maximumAttempts
      ) {
        return attempted;
      }

      const now = yield* Clock.currentTimeMillis;
      const retryDelay = yield* selectRetryDelay(attempted.failure.retryAfter, deadline - now);
      if (Option.isNone(retryDelay)) return attempted;
      const delayMillis = Duration.toMillis(retryDelay.value);
      state.retryDelayMillis = delayMillis;
      yield* telemetry.addBreadcrumb(retryBreadcrumb(state.attemptCount + 1, delayMillis));
      yield* Effect.sleep(retryDelay.value);
    }
    return yield* Effect.die("The model attempt bound was bypassed");
  });

const finishModelTimeout = (
  telemetry: TelemetryService,
  state: ModelAttemptState,
  failure: Cause.TimeoutError
): Effect.Effect<Result.Result<ModelGeneration, Cause.TimeoutError>> =>
  Effect.gen(function* () {
    yield* recordModelCompletion(telemetry, state.attemptCount, {
      outcome: "failed",
      error: Option.some("live_deadline_exhausted"),
      retryable: false,
    });
    yield* recordModelUsage(telemetry, state, Option.none());
    yield* telemetry.captureFailure({
      _tag: "ExhaustedOperationalFailure",
      component: "agent",
      operation: "agent.modelRound",
      error: "live_deadline_exhausted",
      provider: Option.some("openai"),
      retryable: false,
      cause: failure,
    });
    yield* Effect.annotateCurrentSpan({
      "agent.model.attempt_count": state.attemptCount,
      "agent.model.retry_delay_millis": state.retryDelayMillis,
      "agent.model.provider_outcome": "timed_out",
    });
    return Result.fail(failure);
  });

const finishProviderAttempts = (
  telemetry: TelemetryService,
  state: ModelAttemptState,
  result: Result.Result<ModelGeneration, HostedInferenceError>
): Effect.Effect<Result.Result<ModelGeneration, HostedInferenceError>> =>
  Effect.gen(function* () {
    const outcome: DeclaredOutcome = Result.isSuccess(result)
      ? { outcome: "succeeded", error: Option.none(), retryable: false }
      : {
          outcome: "failed",
          error: Option.some("model_unavailable"),
          retryable: result.failure.retryable,
        };
    yield* recordModelCompletion(telemetry, state.attemptCount, outcome);
    yield* recordModelUsage(
      telemetry,
      state,
      Result.isSuccess(result) ? Option.some(result.success) : Option.none()
    );
    if (Result.isFailure(result) && result.failure.reason._tag === "ProviderUnavailable") {
      yield* telemetry.captureFailure({
        _tag: "ExhaustedOperationalFailure",
        component: "agent",
        operation: "agent.modelRound",
        error: "model_unavailable",
        provider: Option.some("openai"),
        retryable: result.failure.retryable,
        cause: result.failure,
      });
    }
    yield* Effect.annotateCurrentSpan({
      "agent.model.attempt_count": state.attemptCount,
      "agent.model.retry_delay_millis": state.retryDelayMillis,
      "agent.model.provider_outcome": Result.isSuccess(result) ? "succeeded" : "failed",
      ...(Result.isFailure(result)
        ? { "agent.model.provider_failure_reason": result.failure.reason._tag }
        : {}),
    });
    return result;
  });

const runModelAttempts = (
  prepare: Effect.Effect<PreparedHostedText, HostedInferenceError>,
  inference: HostedInferenceService,
  roundMillis: number
): Effect.Effect<
  Result.Result<ModelGeneration, ModelRoundFailure>,
  HostedInferenceError,
  Telemetry
> =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;
    const state: ModelAttemptState = { attemptCount: 0, retryDelayMillis: 0 };
    const work = Effect.gen(function* () {
      // Exact counting belongs to the model-round Work, but cannot itself be retried: claiming the
      // semantic context is one-shot and no executable authority exists until preparation succeeds.
      const preparation = yield* Effect.result(prepare);
      if (Result.isFailure(preparation)) {
        const failed: Result.Result<ModelGeneration, HostedInferenceError> = Result.fail(
          preparation.failure
        );
        yield* finishProviderAttempts(telemetry, state, failed);
        return yield* preparation.failure;
      }
      const prepared = preparation.success;
      const round = yield* Effect.result(
        executeModelAttempts({
          attempt: prepared.execute,
          roundMillis,
          telemetry,
          state,
        }).pipe(Effect.timeout(`${roundMillis} millis`))
      );
      const result: Result.Result<ModelGeneration, HostedInferenceError | Cause.TimeoutError> =
        yield* Result.match(round, {
          onFailure: (failure) => finishModelTimeout(telemetry, state, failure),
          onSuccess: (attempts) => finishProviderAttempts(telemetry, state, attempts),
        });
      if (
        Result.isFailure(result) &&
        result.failure instanceof HostedInferenceError &&
        result.failure.reason._tag === "InvalidOutput"
      ) {
        const continuation = yield* prepared.recover;
        return Result.fail<RecoverableHostedOutput>({
          _tag: "RecoverableHostedOutput",
          failure: result.failure,
          continuation,
        });
      }
      if (Result.isFailure(result)) yield* prepared.discard.pipe(Effect.ignore);
      return result;
    });
    return yield* telemetry.span(modelRoundDescriptor, work);
  }).pipe(Effect.withSpan("AgentService.modelRound"));

type HostedContinuationTail = ReturnType<typeof transcriptPrompt>;

const generateCurrentTurn = (
  inference: HostedInferenceService,
  {
    turn,
    continuation,
    continuationTail,
    malformedOutputFeedback,
    remainingToolCalls,
    preparedOverride,
  }: Readonly<{
    turn: HostedTurn;
    continuation: TurnModelContinuation;
    continuationTail: HostedContinuationTail;
    malformedOutputFeedback: Option.Option<string>;
    remainingToolCalls: number;
    preparedOverride: Option.Option<PreparedHostedText>;
  }>
): Effect.Effect<
  Result.Result<HostedTextResult, ModelRoundFailure>,
  OnboardingConsentRequired | HostedInferenceError,
  SqlClient.SqlClient | Telemetry
> =>
  Effect.gen(function* () {
    const prepare =
      Option.isSome(preparedOverride) && Option.isNone(malformedOutputFeedback)
        ? Effect.succeed(preparedOverride.value)
        : Option.match(continuation, {
            onNone: () => Effect.die("A continued round requires HostedInference continuation"),
            onSome: (continued) => {
              const context = makeHostedTextContext({
                prefix: [],
                continuationTail,
                suffix: Option.match(malformedOutputFeedback, {
                  onNone: () => [],
                  onSome: (feedback) => [{ role: "system" as const, content: feedback }],
                }),
              });
              return continued.prepare(
                context,
                remainingToolCalls === 0
                  ? { toolChoice: "none" }
                  : {
                      toolChoice: "auto",
                      maximumToolCalls: HostedToolCallMaximum.make(remainingToolCalls),
                    }
              );
            },
          });
    return yield* runModelAttempts(prepare, inference, turn.limits.maxModelRoundMillis);
  });

const malformedOutputFeedback = (description: string): string => {
  const binding = agentOperationBindings.find(({ wireName }) => description.includes(wireName));
  const callName = binding?.wireName ?? "unknown_tool_call";
  return (
    `The previous operation call ${callName} was malformed and was not executed. ` +
    `Correct its arguments before retrying. Validation reason: ${description}`
  );
};

const annotateModelUsage = Effect.fn("AgentService.annotateModelUsage")(function* (
  generated: HostedTextResult
) {
  yield* Effect.annotateCurrentSpan({
    "agent.model.usage.input_tokens.cache_read": generated.usage.cachedInputTokens,
    "agent.model.usage.input_tokens.total": generated.usage.inputTokens,
    "agent.model.usage.output_tokens.total": generated.usage.outputTokens,
  });
});

const decodeModelToolCalls = Effect.fn("AgentService.decodeModelToolCalls")(function* (
  generated: HostedTextResult
): Effect.fn.Return<ReadonlyArray<AgentToolCall>, ModelResponseRejected> {
  const toolCalls: Array<AgentToolCall> = [];
  for (const toolCall of generated.toolCalls) {
    const binding = yield* findAgentOperationBinding(toolCall.name).pipe(
      Option.match({
        onNone: () =>
          Effect.fail(modelResponseRejected(new Error("Model named an unknown operation"))),
        onSome: Effect.succeed,
      })
    );
    const params = yield* decodeAgentOperationInput(binding, toolCall.params).pipe(
      Effect.mapError(modelResponseRejected)
    );
    toolCalls.push({ id: toolCall.id, name: binding.wireName, params });
  }
  return toolCalls;
});

const malformedOutputRetry = (
  description: string,
  continuation: Option.Option<HostedTextContinuation>
): Effect.Effect<ModelRoundDecision, ModelResponseRejected> =>
  containsSensitiveChatValue(description)
    ? Effect.fail(modelResponseRejected(new Error("Model output contained a sensitive chat value")))
    : Effect.succeed({
        _tag: "Retry",
        feedback: malformedOutputFeedback(description),
        continuation,
      });

const acceptGeneratedRound = Effect.fn("AgentService.acceptGeneratedRound")(function* (
  generated: HostedTextResult
): Effect.fn.Return<ModelRoundDecision, ModelResponseRejected> {
  yield* annotateModelUsage(generated);
  const decoded = yield* Effect.result(decodeModelToolCalls(generated));
  if (Result.isFailure(decoded)) {
    const description = String(decoded.failure.cause);
    if (containsSensitiveChatValue(description)) return yield* decoded.failure;
    return yield* malformedOutputRetry(description, Option.some(generated.continuation));
  }
  return {
    _tag: "Accepted",
    generated: {
      text: generated.text,
      toolCalls: decoded.success,
      finishReason: generated.finishReason,
      continuation: generated.continuation,
    },
  };
});

const acceptRecoverableHostedOutput = (
  failure: RecoverableHostedOutput
): Effect.Effect<ModelRoundDecision, ModelResponseRejected> =>
  malformedOutputRetry(
    failure.failure.reason._tag === "InvalidOutput"
      ? failure.failure.reason.description
      : "Hosted provider response was invalid",
    Option.some(failure.continuation)
  );

const mapHostedInferenceFailure = (
  failure: HostedInferenceError
): ModelUnavailable | HostedCapacityExceeded =>
  failure.reason._tag === "CapacityExceeded"
    ? new HostedCapacityExceeded()
    : new ModelUnavailable({ cause: failure });

const acceptHostedInferenceFailure = Effect.fn("AgentService.acceptHostedInferenceFailure")(
  function* (
    failure: HostedInferenceError
  ): Effect.fn.Return<
    ModelRoundDecision,
    HostedCapacityExceeded | ModelUnavailable | ModelResponseRejected
  > {
    yield* Effect.annotateCurrentSpan({
      "agent.model.failure.reason": failure.reason._tag,
      "agent.model.failure.retryable": failure.retryable,
      ...Option.match(failure.retryAfter, {
        onNone: () => ({}),
        onSome: (retryAfter) => ({
          "agent.model.failure.retry_after_millis": Duration.toMillis(retryAfter),
        }),
      }),
    });
    if (failure.reason._tag !== "InvalidOutput") {
      return yield* mapHostedInferenceFailure(failure);
    }
    return yield* malformedOutputRetry(failure.reason.description, Option.none());
  }
);

type ModelRound = Effect.Success<ReturnType<typeof generateCurrentTurn>>;

const acceptNonHostedFailure = (
  failure: Exclude<ModelRoundFailure, HostedInferenceError>
): Effect.Effect<ModelRoundDecision, ModelUnavailable | ModelResponseRejected> =>
  failure._tag === "RecoverableHostedOutput"
    ? acceptRecoverableHostedOutput(failure)
    : Effect.fail(new ModelUnavailable({ cause: failure }));

const acceptModelRoundFailure = (
  failure: ModelRoundFailure
): Effect.Effect<
  ModelRoundDecision,
  HostedCapacityExceeded | ModelUnavailable | ModelResponseRejected
> =>
  failure instanceof HostedInferenceError
    ? acceptHostedInferenceFailure(failure)
    : acceptNonHostedFailure(failure);

const acceptModelRound = (
  round: ModelRound
): Effect.Effect<
  ModelRoundDecision,
  HostedCapacityExceeded | ModelUnavailable | ModelResponseRejected
> =>
  Result.match(round, {
    onFailure: acceptModelRoundFailure,
    onSuccess: acceptGeneratedRound,
  });

const loadTurnContext = (
  userId: UserId,
  message: InboundMessage
): Effect.Effect<
  Readonly<{ user: User; confirmation: HostedTurn["confirmation"] }>,
  OnboardingConsentRequired | UnknownUser,
  Crypto.Crypto | SqlClient.SqlClient
> =>
  withCurrentConsent(
    userId,
    Effect.gen(function* () {
      const user = yield* findUser(userId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new UnknownUser({ userId })),
            onSome: Effect.succeed,
          })
        )
      );
      const confirmation = yield* makeTurnConfirmation(userId, message);
      return { user, confirmation } as const;
    })
  );

const iterationReply = (
  turn: HostedTurn,
  iteration: AgentIteration,
  text: TranscriptText
): PreparedAgentReply => preparedReply(makeTextReply(text), Option.some({ iteration }));

const loadContinuationTail = ({
  turn,
  iteration,
  generated,
}: Readonly<{
  turn: HostedTurn;
  iteration: AgentIteration;
  generated: AcceptedGeneration;
}>): HostedContinuationTail => {
  const callIds = new Set(generated.toolCalls.map(({ id }) => id));
  return turn.continuationEntries.flatMap((entry): HostedContinuationTail => {
    if (
      entry._tag !== "CanonicalToolResultEntry" ||
      entry.iteration !== iteration ||
      !callIds.has(entry.toolCallId)
    ) {
      return [];
    }
    const binding = agentOperationBindings.find(({ operation }) => operation === entry.operation);
    if (binding === undefined) return [];
    const failed = entry.outcome._tag !== "Succeeded";
    const canonicalResult =
      entry.outcome._tag === "Succeeded" ? entry.outcome.output : entry.outcome.failure;
    const result =
      JSON.stringify(canonicalResult).length <= turn.limits.maxToolResultCharacters
        ? canonicalResult
        : {
            code: "tool_result_too_large",
            message: "The canonical result exceeded the model-context safety limit.",
          };
    return [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            id: entry.toolCallId,
            name: binding.wireName,
            result,
            isFailure: failed,
          },
        ],
      },
    ];
  });
};

const recordMalformedOutputExhaustion = (
  feedback: Option.Option<string>
): Effect.Effect<void, never, Telemetry> =>
  Option.match(feedback, {
    onNone: () => Effect.void,
    onSome: () =>
      Effect.flatMap(Telemetry, (telemetry) =>
        telemetry.captureFailure({
          _tag: "ExhaustedOperationalFailure",
          component: "agent",
          operation: "agent.modelRound",
          error: "model_unavailable",
          provider: Option.some("openai"),
          retryable: false,
          cause: new Error("Model output recovery exhausted"),
        })
      ),
  });

const runHostedTurn = (
  inference: HostedInferenceService,
  turn: HostedTurn
): Effect.Effect<
  PreparedAgentReply,
  HostedCapacityExceeded | ModelUnavailable | ModelResponseRejected | OnboardingConsentRequired,
  Crypto.Crypto | SqlClient.SqlClient | Telemetry
> =>
  Effect.gen(function* () {
    let toolCalls = 0;
    let continuation: TurnModelContinuation = Option.none();
    let continuationTail: HostedContinuationTail = [];
    let feedback = Option.none<string>();
    for (let index = 1; index <= turn.limits.maxIterations; index += 1) {
      const iteration = AgentIteration.make(index);
      const roundDecision = yield* acceptModelRound(
        yield* generateCurrentTurn(inference, {
          turn,
          continuation,
          continuationTail,
          malformedOutputFeedback: feedback,
          remainingToolCalls: turn.limits.maxToolCallsPerTurn - toolCalls,
          preparedOverride: index === 1 ? Option.some(turn.initialPrepared) : Option.none(),
        }).pipe(
          Effect.catchTag("HostedInferenceError", (failure) =>
            Effect.fail(mapHostedInferenceFailure(failure))
          )
        )
      );
      if (roundDecision._tag === "Retry") {
        feedback = Option.some(roundDecision.feedback);
        if (Option.isSome(roundDecision.continuation)) {
          continuation = roundDecision.continuation;
          continuationTail = [];
        }
        continue;
      }
      feedback = Option.none();
      const { generated } = roundDecision;

      if (generated.toolCalls.length > turn.limits.maxToolCallsPerTurn - toolCalls) break;
      toolCalls += generated.toolCalls.length;

      const response = yield* respondToGeneration(turn, iteration, generated);
      if (response._tag === "Completed") return iterationReply(turn, iteration, response.text);
      continuation = Option.some(generated.continuation);
      continuationTail = loadContinuationTail({ turn, iteration, generated });
    }

    yield* recordMalformedOutputExhaustion(feedback);
    return iterationReply(turn, AgentIteration.make(turn.limits.maxIterations), exhaustedReply);
  });

const decodeAgentTurnFailureTag = Schema.decodeUnknownOption(
  Schema.Literals([
    "UnknownUser",
    "OnboardingConsentRequired",
    "HostedCapacityExceeded",
    "ModelUnavailable",
    "ModelResponseRejected",
  ])
);

const turnFailureTag = (failure: unknown): Option.Option<AgentTurnError["_tag"]> => {
  if (typeof failure !== "object" || failure === null || !("_tag" in failure)) {
    return Option.none();
  }
  return decodeAgentTurnFailureTag(failure._tag);
};

const turnFailureOutcomeFromTag = (tag: AgentTurnError["_tag"]): DeclaredOutcome => {
  switch (tag) {
    case "UnknownUser":
      return { outcome: "rejected", error: Option.some("unknown_user"), retryable: false };
    case "OnboardingConsentRequired":
      return { outcome: "rejected", error: Option.some("consent_required"), retryable: false };
    case "HostedCapacityExceeded":
      return { outcome: "rejected", error: Option.some("model_unavailable"), retryable: false };
    case "ModelResponseRejected":
      return {
        outcome: "rejected",
        error: Option.some("model_response_rejected"),
        retryable: false,
      };
    case "ModelUnavailable":
      return { outcome: "failed", error: Option.some("model_unavailable"), retryable: false };
  }
};

const recordTurnExit = (
  telemetry: TelemetryService,
  exit: Exit.Exit<unknown, unknown>
): Effect.Effect<void> => {
  if (Exit.isSuccess(exit)) return Effect.void;
  const { cause } = exit;
  if (Cause.hasInterrupts(cause) && !Cause.hasDies(cause) && !Cause.hasFails(cause)) {
    return telemetry.recordOutcome({
      outcome: "interrupted",
      error: Option.none(),
      retryable: false,
    });
  }
  if (Cause.hasDies(cause)) {
    return Effect.all(
      [
        telemetry.recordOutcome({
          outcome: "failed",
          error: Option.some("unexpected_defect"),
          retryable: false,
        }),
        telemetry.captureFailure({
          _tag: "Defect",
          component: "agent",
          operation: "agent.hostedTurn",
          error: "unexpected_defect",
          cause,
        }),
      ],
      { discard: true }
    );
  }
  return Option.match(Exit.findErrorOption(exit).pipe(Option.flatMap(turnFailureTag)), {
    onNone: () => Effect.void,
    onSome: (tag) => telemetry.recordOutcome(turnFailureOutcomeFromTag(tag)),
  });
};

const maximumContinuityPreparations = 3;

type AgentServiceDependencies = Readonly<{
  inference: HostedInferenceService;
  continuity: ConversationContinuity["Service"];
  telemetry: TelemetryService;
  crypto: Crypto.Crypto;
  httpClient: HttpClient.HttpClient;
  sqlClient: SqlClient.SqlClient;
}>;

const prepareInitialRound = (
  inference: HostedInferenceService,
  context: WorkingContext,
  maximumToolCalls: number
): Effect.Effect<PreparedHostedText, HostedInferenceError> =>
  inference.prepareText({
    _tag: "Initial",
    context,
    toolChoice: "auto",
    maximumToolCalls: HostedToolCallMaximum.make(maximumToolCalls),
  });

const beginPreparedTurn = Effect.fn("AgentService.beginPreparedTurn")(function* (
  prepared: PreparedAttempt,
  firstRound: PreparedHostedText
): Effect.fn.Return<PendingTurn, ContinuityChanged | ModelUnavailable> {
  const admission = yield* Effect.result(prepared.begin());
  if (Result.isSuccess(admission)) return admission.success;
  yield* firstRound.discard.pipe(
    Effect.catchTag("HostedInferenceError", (cause) => Effect.fail(new ModelUnavailable({ cause })))
  );
  return yield* admission.failure;
});

const generateHostedReply = Effect.fn("AgentService.generateHostedReply")(function* (input: {
  dependencies: AgentServiceDependencies;
  userId: UserId;
  message: InboundMessage;
  limits: AgentLimits;
  context: WorkingContext;
  pending: PendingTurn;
  firstRound: PreparedHostedText;
}) {
  const { dependencies, userId, message, limits, context, pending, firstRound } = input;
  const { user, confirmation } = yield* loadTurnContext(userId, message);
  const hostedToken = yield* withCurrentConsent(
    userId,
    issueHostedAgentToken(userId, context.startedAt)
  );
  return yield* Effect.scoped(
    Effect.gen(function* () {
      const toolkit = yield* makeAgentToolkit(hostedToken.bearer);
      return yield* runHostedTurn(dependencies.inference, {
        userId,
        user,
        startedAt: context.startedAt,
        limits,
        confirmation,
        toolkit,
        pending,
        continuationEntries: [],
        initialPrepared: firstRound,
      });
    })
  ).pipe(
    Effect.ensuring(
      DateTime.now.pipe(
        Effect.flatMap((revokedAt) =>
          revokeHostedAgentToken(userId, hostedToken.tokenId, revokedAt)
        )
      )
    )
  );
});

const deliverAndComplete = Effect.fn("AgentService.deliverAndComplete")(function* <E, R>(input: {
  pending: PendingTurn;
  generated: PreparedAgentReply;
  deliver: (reply: AgentReply) => Effect.Effect<void, E, R>;
}) {
  const { pending, generated, deliver } = input;
  const delivered = yield* Effect.result(deliver(generated.reply));
  if (Result.isFailure(delivered)) {
    yield* pending.fail("DeliveryFailed");
    return yield* Effect.fail(delivered.failure);
  }
  yield* Option.match(generated.assistantEntry, {
    onNone: () => pending.fail("HostedInferenceFailed"),
    onSome: ({ iteration }) => pending.complete({ iteration, text: generated.reply.text }),
  });
  return generated.reply;
});

const runPreparedAttempt = Effect.fn("AgentService.runPreparedAttempt")(function* <E, R>(input: {
  dependencies: AgentServiceDependencies;
  userId: UserId;
  message: InboundMessage;
  prepared: PreparedAttempt;
  deliver: (reply: AgentReply) => Effect.Effect<void, E, R>;
}) {
  const { dependencies, userId, message, prepared, deliver } = input;
  const limits = yield* CurrentAgentLimits;
  const context = yield* makeWorkingContext(prepared.context).pipe(
    Effect.mapError(() => new UnknownUser({ userId }))
  );
  const firstRound = yield* prepareInitialRound(
    dependencies.inference,
    context,
    limits.maxToolCallsPerTurn
  ).pipe(Effect.mapError(mapHostedInferenceFailure));
  const pending = yield* beginPreparedTurn(prepared, firstRound);
  const generation = yield* Effect.result(
    generateHostedReply({
      dependencies,
      userId,
      message,
      limits,
      context,
      pending,
      firstRound,
    })
  );
  if (Result.isFailure(generation)) {
    yield* pending.fail("HostedInferenceFailed");
    return yield* generation.failure;
  }
  return yield* deliverAndComplete({ pending, generated: generation.success, deliver });
});

type SerializedTurnInput<E, R> = Readonly<{
  dependencies: AgentServiceDependencies;
  userId: UserId;
  message: InboundMessage;
  deliver: (reply: AgentReply) => Effect.Effect<void, E, R>;
}>;

const runBoundedPreparation = <E, R>(
  input: SerializedTurnInput<E, R> &
    Readonly<{ attempt: SerializedAttempt; preparationNumber: number }>
): Effect.Effect<
  AgentReply,
  AgentTurnError | E,
  R | Crypto.Crypto | HttpClient.HttpClient | SqlClient.SqlClient
> => {
  const { dependencies, attempt, userId, message, deliver, preparationNumber } = input;
  return attempt
    .prepare((prepared) =>
      runPreparedAttempt({ dependencies, userId, message, prepared, deliver }).pipe(
        Effect.provideService(Telemetry, dependencies.telemetry)
      )
    )
    .pipe(
      Effect.catchTag("ContinuityChanged", (changed) =>
        preparationNumber < maximumContinuityPreparations
          ? runBoundedPreparation({ ...input, preparationNumber: preparationNumber + 1 })
          : Effect.fail(new ModelUnavailable({ cause: changed }))
      )
    );
};

const runSerializedTurn = <E, R>(
  input: SerializedTurnInput<E, R>
): Effect.Effect<
  AgentReply,
  AgentTurnError | E,
  R | Crypto.Crypto | HttpClient.HttpClient | SqlClient.SqlClient
> =>
  input.dependencies.continuity.withSerializedAttempt(input.userId, input.message, (attempt) =>
    runBoundedPreparation({ ...input, attempt, preparationNumber: 1 })
  );

const provideAgentDependencies = <A, E, R>(
  dependencies: AgentServiceDependencies,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<
  A,
  E,
  Exclude<Exclude<Exclude<R, Crypto.Crypto>, HttpClient.HttpClient>, SqlClient.SqlClient>
> =>
  effect.pipe(
    Effect.provideService(Crypto.Crypto, dependencies.crypto),
    Effect.provideService(HttpClient.HttpClient, dependencies.httpClient),
    Effect.provideService(SqlClient.SqlClient, dependencies.sqlClient)
  );

const makeHandleTurn =
  (dependencies: AgentServiceDependencies) =>
  <E, R>(
    userId: UserId,
    message: InboundMessage,
    deliver: (reply: AgentReply) => Effect.Effect<void, E, R>
  ): Effect.Effect<AgentReply, AgentTurnError | E, R> => {
    if (containsSensitiveChatValue(message.text)) {
      return Effect.succeed(makeTextReply(credentialRejectedReply));
    }
    const authorized = withCurrentConsent(userId, Effect.succeed(message));
    const work = Effect.flatMap(authorized, (currentMessage) =>
      runSerializedTurn({ dependencies, userId, message: currentMessage, deliver })
    );
    const traced = dependencies.telemetry.span(
      turnDescriptor,
      Effect.onExit(work.pipe(Effect.provideService(Telemetry, dependencies.telemetry)), (exit) =>
        recordTurnExit(dependencies.telemetry, exit)
      )
    );
    return provideAgentDependencies(dependencies, traced);
  };

const makeAgentService = Effect.gen(function* () {
  const dependencies: AgentServiceDependencies = {
    inference: yield* HostedInference,
    continuity: yield* ConversationContinuity,
    telemetry: yield* Telemetry,
    crypto: yield* Crypto.Crypto,
    httpClient: yield* HttpClient.HttpClient,
    sqlClient: yield* SqlClient.SqlClient,
  };
  const handleTurn = makeHandleTurn(dependencies);
  return AgentService.of({
    handleTurn,
    handleSynchronousTurn: (userId, message) => handleTurn(userId, message, () => Effect.void),
  });
});

/**
 * Runs one hosted Turn wholly inside a callback-scoped User serialization authority. Complete
 * hosted preflight precedes admission; delivery and terminalization precede callback closure.
 */
export class AgentService extends Context.Service<
  AgentService,
  {
    readonly handleTurn: <E, R>(
      userId: UserId,
      message: InboundMessage,
      deliver: (reply: AgentReply) => Effect.Effect<void, E, R>
    ) => Effect.Effect<AgentReply, AgentTurnError | E, R>;
    readonly handleSynchronousTurn: (
      userId: UserId,
      message: InboundMessage
    ) => Effect.Effect<AgentReply, AgentTurnError>;
  }
>()("fidy-ai/shell/agent/agent-service/AgentService") {
  /** Constructs the hosted agent from the external model and persistent slice seams. */
  static readonly layer = Layer.effect(this, makeAgentService).pipe(
    Layer.provide(
      ConversationContinuity.layer.pipe(
        Layer.provide(
          ConversationCompactionInference.layer(
            Effect.map(HostedInference, (inference) => ({
              countText: inference.countText,
              countTranscript: inference.countTranscript,
              generate: (
                prior,
                entries
              ): Effect.Effect<CompactedConversationOutput, ConversationCompactionInferenceError> =>
                inference
                  .prepareStructured({
                    context: makeHostedStructuredContext({
                      messages: [
                        {
                          role: "system",
                          content:
                            "Replace the prior compacted conversation and exact transcript with one faithful concise conversation record.",
                        },
                        ...Option.match(prior, {
                          onNone: () => [],
                          onSome: (text) => [{ role: "user" as const, content: text }],
                        }),
                        ...exactTranscriptPrompt(entries),
                      ],
                    }),
                    objectName: HostedStructuredObjectName.make("compacted_conversation"),
                    outputSchema: CompactedConversationOutput,
                  })
                  .pipe(
                    Effect.flatMap((prepared) => prepared.execute),
                    Effect.mapError((cause) => new ConversationCompactionInferenceError({ cause }))
                  ),
            }))
          )
        )
      )
    )
  );
}
