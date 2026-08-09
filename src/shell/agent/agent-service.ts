import {
  type Cause,
  Clock,
  Context,
  Crypto,
  Data,
  DateTime,
  Duration,
  Effect,
  Layer,
  Option,
  Random,
  Result,
  Schema,
  Stream,
  Struct,
} from "effect";
import { type AiError, LanguageModel, Prompt, type Response, type Tool } from "effect/unstable/ai";
import type { HttpClient } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import type { User } from "~/core/identity/model";
import type { UserId } from "~/core/identity/reference";
import {
  TranscriptWindowCharacterLimit,
  type TranscriptWindowEntry,
  TranscriptWindowTurnLimit,
  selectTranscriptWindow,
} from "~/core/transcript/rules";
import {
  AgentIteration,
  AssistantTranscriptEntry,
  CanonicalToolCallEntry,
  type CanonicalToolOutcome,
  CanonicalToolResultEntry,
  ToolCallId,
  type TranscriptEntry,
  TranscriptEntryId,
  TranscriptText,
  TranscriptTurnId,
  UserTranscriptEntry,
} from "~/core/transcript/model";
import { ValidationFailed } from "~/shell/_shared/errors";
import { useCurrentConsent } from "~/shell/consent/repo";
import { findUser } from "~/shell/identity/repo";
import {
  type DeclaredOutcome,
  type SpanDescriptor,
  TelemetryAttempt,
  type TelemetryBreadcrumb,
  TelemetryDuration,
} from "~/shell/observability/protocol";
import { Telemetry, type TelemetryService } from "~/shell/observability/telemetry";
import { atomicBatchOperation } from "~/shell/operations/operations";
import { issueHostedAgentToken, revokeHostedAgentToken } from "~/shell/tokens/hosted-agent-token";
import {
  appendTranscriptEntries,
  listRecentTranscriptEntries,
  listTranscriptTurnEntries,
} from "~/shell/transcript/transcript-service";
import {
  containsSensitiveChatValue,
  containsSensitiveJson,
  credentialRejectedReply,
  projectTranscriptForModel,
  sensitiveEntryRejected,
  systemPrompt,
  transcriptPrompt,
  turnPrompt,
} from "./model-boundary";
import { HostedToolCallCap, withHostedToolCallCap } from "./openai";
import { makeTurnConfirmation } from "./tool-confirmation";
import { renderTransactionReceipt } from "./transaction-receipt";
import {
  type AgentOperationBinding,
  agentOperationBindings,
  decodeAgentOperationInput,
  findAgentOperationBinding,
  makeAgentToolkit,
} from "./toolkit";

const minimumTranscriptWindowCharacters = 1_000;
const defaultTranscriptWindowTurns = 12;
const defaultTranscriptWindowCharacters = 32_000;
const attemptWindowMillis = 250;
const modelRetryPolicy = {
  maximumAttempts: 2,
  minimumAttemptWindow: Duration.millis(attemptWindowMillis),
  fallbackDelay: Duration.millis(100),
  jitterWindow: Duration.millis(100),
} as const;
const modelRoundDescriptor: SpanDescriptor = {
  component: "agent",
  operation: "agent.modelRound",
  trigger: "api",
  spanOperation: "agent.model",
  workKind: "model_round",
  metadata: { _tag: "None" },
};

/** Resource and context bounds applied independently to every hosted turn. */
export const AgentLimits = Schema.Struct({
  maxIterations: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
  maxToolCallsPerTurn: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
  maxToolResultCharacters: Schema.Int.check(
    Schema.isBetween({ minimum: 1_000, maximum: 1_000_000 })
  ),
  maxTranscriptTurns: TranscriptWindowTurnLimit,
  maxTranscriptCharacters: TranscriptWindowCharacterLimit.check(
    Schema.isGreaterThanOrEqualTo(minimumTranscriptWindowCharacters)
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
        maxTranscriptTurns: TranscriptWindowTurnLimit.make(defaultTranscriptWindowTurns),
        maxTranscriptCharacters: TranscriptWindowCharacterLimit.make(
          defaultTranscriptWindowCharacters
        ),
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
  | ModelUnavailable
  | ModelResponseRejected;

const makeEntryId = Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv7).pipe(
  Effect.map((id) => TranscriptEntryId.make(id)),
  Effect.orDie
);
const makeTurnId = Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv7).pipe(
  Effect.map((id) => TranscriptTurnId.make(id)),
  Effect.orDie
);
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

const appendAuthorizedTranscript = (
  subjectUserId: UserId,
  entries: ReadonlyArray<TranscriptEntry>
): Effect.Effect<void, OnboardingConsentRequired, SqlClient.SqlClient> =>
  withCurrentConsent(subjectUserId, appendTranscriptEntries(subjectUserId, entries));

const appendAssistantTranscript = Effect.fn("AgentService.appendAssistantTranscript")(function* ({
  userId,
  turnId,
  iteration,
  text,
}: {
  readonly userId: UserId;
  readonly turnId: TranscriptTurnId;
  readonly iteration: AgentIteration;
  readonly text: TranscriptText;
}) {
  yield* withCurrentConsent(
    userId,
    Effect.gen(function* () {
      yield* appendTranscriptEntries(userId, [
        AssistantTranscriptEntry.make({
          id: yield* makeEntryId,
          turnId,
          iteration,
          text,
          occurredAt: yield* DateTime.now,
        }),
      ]);
    })
  );
});
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
export type PreparedAgentReply = Readonly<{
  reply: AgentReply;
  assistantEntry: Option.Option<
    Readonly<{
      userId: UserId;
      turnId: TranscriptTurnId;
      iteration: AgentIteration;
    }>
  >;
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
  turnId: TranscriptTurnId;
  user: User;
  startedAt: DateTime.Utc;
  limits: AgentLimits;
  confirmation: Effect.Success<ReturnType<typeof makeTurnConfirmation>>;
  toolkit: AgentToolkitInstance;
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
  responseParts: ReadonlyArray<Response.AnyPart>;
  finishReason: Response.FinishReason;
}>;

type TurnModelContinuation = ReadonlyArray<Prompt.MessageEncoded>;

type ModelRoundDecision = Readonly<
  { _tag: "Accepted"; generated: AcceptedGeneration } | { _tag: "Retry"; feedback: string }
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
  yield* appendAuthorizedTranscript(turn.userId, [
    CanonicalToolResultEntry.make({
      id: yield* makeEntryId,
      turnId: turn.turnId,
      iteration: call.iteration,
      toolCallId: call.toolCallId,
      operation: call.binding.operation,
      outcome,
      occurredAt: yield* DateTime.now,
    }),
  ]);
});

const recordToolCall = Effect.fn("AgentService.recordToolCall")(function* (
  turn: HostedTurn,
  call: RecordedCall,
  input: Schema.Json
) {
  yield* appendAuthorizedTranscript(turn.userId, [
    CanonicalToolCallEntry.make({
      id: yield* makeEntryId,
      turnId: turn.turnId,
      iteration: call.iteration,
      toolCallId: call.toolCallId,
      operation: call.binding.operation,
      input,
      occurredAt: yield* DateTime.now,
    }),
  ]);
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
  if (containsSensitiveJson(input)) {
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

const loadTranscriptWindow = (
  userId: UserId,
  turnId: TranscriptTurnId,
  limits: AgentLimits
): Effect.Effect<
  ReadonlyArray<TranscriptWindowEntry>,
  OnboardingConsentRequired,
  SqlClient.SqlClient
> =>
  withCurrentConsent(
    userId,
    Effect.all({
      currentTranscript: listTranscriptTurnEntries(userId, turnId),
      priorTurns:
        limits.maxTranscriptTurns === 1
          ? Effect.succeed([])
          : listRecentTranscriptEntries(userId, limits.maxTranscriptTurns - 1),
    }).pipe(
      Effect.map(({ currentTranscript, priorTurns }) =>
        projectTranscriptForModel(
          [...priorTurns, ...currentTranscript],
          limits.maxToolResultCharacters
        )
      ),
      Effect.flatMap((transcript) =>
        selectTranscriptWindow(
          transcript,
          limits.maxTranscriptTurns,
          limits.maxTranscriptCharacters
        )
      )
    )
  );

const fallbackRetryDelay = Random.nextIntBetween(
  0,
  Duration.toMillis(modelRetryPolicy.jitterWindow)
).pipe(
  Effect.map((jitterMillis) =>
    Duration.millis(Duration.toMillis(modelRetryPolicy.fallbackDelay) + jitterMillis)
  )
);

type ModelGeneration = LanguageModel.GenerateTextResponse<AgentToolkitInstance["tools"]>;

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
      attempt: Option.some(TelemetryAttempt.make(attemptCount)),
      durationMilliseconds: Option.none(),
    }),
    telemetry.recordOutcome(outcome),
  ]).pipe(Effect.asVoid);

type ModelAttemptState = {
  attemptCount: number;
  retryDelayMillis: number;
};

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
  attempt: Effect.Effect<ModelGeneration, AiError.AiError>;
  roundMillis: number;
  telemetry: TelemetryService;
  state: ModelAttemptState;
}>): Effect.Effect<Result.Result<ModelGeneration, AiError.AiError>> =>
  Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    const deadline = startedAt + roundMillis;
    while (state.attemptCount < modelRetryPolicy.maximumAttempts) {
      state.attemptCount += 1;
      const attempted = yield* Effect.result(attempt);
      if (Result.isSuccess(attempted)) return attempted;
      if (
        !attempted.failure.isRetryable ||
        state.attemptCount === modelRetryPolicy.maximumAttempts
      ) {
        return attempted;
      }

      const now = yield* Clock.currentTimeMillis;
      const retryDelay = yield* selectRetryDelay(
        Option.fromNullishOr(attempted.failure.retryAfter),
        deadline - now
      );
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
  result: Result.Result<ModelGeneration, AiError.AiError>
): Effect.Effect<Result.Result<ModelGeneration, AiError.AiError>> =>
  Effect.gen(function* () {
    const outcome: DeclaredOutcome = Result.isSuccess(result)
      ? { outcome: "succeeded", error: Option.none(), retryable: false }
      : {
          outcome: "failed",
          error: Option.some("model_unavailable"),
          retryable: result.failure.isRetryable,
        };
    yield* recordModelCompletion(telemetry, state.attemptCount, outcome);
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
  attempt: Effect.Effect<ModelGeneration, AiError.AiError>,
  roundMillis: number
): Effect.Effect<
  Result.Result<ModelGeneration, AiError.AiError | Cause.TimeoutError>,
  never,
  Telemetry
> =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;
    const state: ModelAttemptState = { attemptCount: 0, retryDelayMillis: 0 };
    const work = Effect.gen(function* () {
      const round = yield* Effect.result(
        executeModelAttempts({ attempt, roundMillis, telemetry, state }).pipe(
          Effect.timeout(`${roundMillis} millis`)
        )
      );
      return yield* Result.match(round, {
        onFailure: (failure) => finishModelTimeout(telemetry, state, failure),
        onSuccess: (result) => finishProviderAttempts(telemetry, state, result),
      });
    });
    return yield* telemetry.span(modelRoundDescriptor, work);
  }).pipe(Effect.withSpan("AgentService.modelRound"));

const generateCurrentTurn = (
  model: LanguageModel.Service,
  {
    turn,
    continuation,
    malformedOutputFeedback,
    remainingToolCalls,
  }: Readonly<{
    turn: HostedTurn;
    continuation: TurnModelContinuation;
    malformedOutputFeedback: Option.Option<string>;
    remainingToolCalls: number;
  }>
): Effect.Effect<
  Result.Result<
    LanguageModel.GenerateTextResponse<AgentToolkitInstance["tools"]>,
    AiError.AiError | Cause.TimeoutError
  >,
  OnboardingConsentRequired,
  SqlClient.SqlClient | Telemetry
> =>
  Effect.gen(function* () {
    const transcriptWindow = yield* loadTranscriptWindow(turn.userId, turn.turnId, turn.limits);
    const durableTranscript =
      continuation.length === 0
        ? transcriptWindow
        : transcriptWindow.filter(
            (entry) =>
              entry.turnId !== turn.turnId ||
              (entry._tag !== "CanonicalToolCallEntry" && entry._tag !== "CanonicalToolResultEntry")
          );
    const generation = model.generateText({
      prompt: [
        { role: "system", content: systemPrompt(turn.user) },
        ...transcriptPrompt(durableTranscript),
        ...continuation,
        { role: "system", content: turnPrompt(turn.startedAt) },
        ...Option.match(malformedOutputFeedback, {
          onNone: () => [],
          onSome: (feedback) => [{ role: "system" as const, content: feedback }],
        }),
      ],
      toolkit: turn.toolkit,
      toolChoice: remainingToolCalls === 0 ? "none" : "auto",
      disableToolCallResolution: true,
    });
    const boundedGeneration =
      remainingToolCalls === 0
        ? generation
        : generation.pipe(withHostedToolCallCap(HostedToolCallCap.make(remainingToolCalls)));
    return yield* runModelAttempts(boundedGeneration, turn.limits.maxModelRoundMillis);
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
  generated: LanguageModel.GenerateTextResponse<AgentToolkitInstance["tools"]>
) {
  yield* Effect.annotateCurrentSpan({
    "agent.model.usage.input_tokens.cache_read": generated.usage.inputTokens.cacheRead ?? 0,
    "agent.model.usage.input_tokens.total": generated.usage.inputTokens.total ?? 0,
    "agent.model.usage.output_tokens.total": generated.usage.outputTokens.total ?? 0,
  });
});

const decodeModelToolCalls = Effect.fn("AgentService.decodeModelToolCalls")(function* (
  generated: LanguageModel.GenerateTextResponse<AgentToolkitInstance["tools"]>
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
    toolCalls.push({ ...toolCall, params });
  }
  return toolCalls;
});

const acceptModelRound = Effect.fn("AgentService.acceptModelRound")(function* (
  round: Effect.Success<ReturnType<typeof generateCurrentTurn>>
): Effect.fn.Return<ModelRoundDecision, ModelUnavailable | ModelResponseRejected> {
  if (Result.isSuccess(round)) {
    yield* annotateModelUsage(round.success);
    return {
      _tag: "Accepted",
      generated: {
        text: round.success.text,
        toolCalls: yield* decodeModelToolCalls(round.success),
        responseParts: round.success.content,
        finishReason: round.success.finishReason,
      },
    };
  }
  const { failure } = round;
  if (!("reason" in failure)) return yield* new ModelUnavailable({ cause: failure });
  yield* Effect.annotateCurrentSpan({
    "agent.model.failure.reason": failure.reason._tag,
    "agent.model.failure.retryable": failure.isRetryable,
    ...(failure.retryAfter === undefined
      ? {}
      : { "agent.model.failure.retry_after_millis": Duration.toMillis(failure.retryAfter) }),
  });
  if (failure.reason._tag !== "InvalidOutputError") {
    return yield* new ModelUnavailable({ cause: failure });
  }
  if (containsSensitiveChatValue(failure.reason.description)) {
    return yield* modelResponseRejected(new Error("Model output contained a sensitive chat value"));
  }
  return { _tag: "Retry", feedback: malformedOutputFeedback(failure.reason.description) };
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
): PreparedAgentReply =>
  preparedReply(
    makeTextReply(text),
    Option.some({ userId: turn.userId, turnId: turn.turnId, iteration })
  );

const preserveModelContinuation = Effect.fn("AgentService.preserveModelContinuation")(function* ({
  turn,
  iteration,
  generated,
  continuation,
}: Readonly<{
  turn: HostedTurn;
  iteration: AgentIteration;
  generated: AcceptedGeneration;
  continuation: TurnModelContinuation;
}>) {
  const callIds = new Set(generated.toolCalls.map(({ id }) => id));
  const toolResults = yield* withCurrentConsent(
    turn.userId,
    listTranscriptTurnEntries(turn.userId, turn.turnId).pipe(
      Effect.map((entries) =>
        projectTranscriptForModel(
          entries.filter(
            (entry) =>
              entry._tag === "CanonicalToolResultEntry" &&
              entry.iteration === iteration &&
              callIds.has(entry.toolCallId)
          ),
          turn.limits.maxToolResultCharacters
        )
      )
    )
  );
  return [
    ...continuation,
    ...Prompt.fromResponseParts(generated.responseParts).content,
    ...transcriptPrompt(toolResults),
  ];
});

const runHostedTurn = (
  model: LanguageModel.Service,
  turn: HostedTurn
): Effect.Effect<
  PreparedAgentReply,
  ModelUnavailable | ModelResponseRejected | OnboardingConsentRequired,
  Crypto.Crypto | SqlClient.SqlClient | Telemetry
> =>
  Effect.gen(function* () {
    let toolCalls = 0;
    let continuation: TurnModelContinuation = [];
    let feedback = Option.none<string>();
    for (let index = 1; index <= turn.limits.maxIterations; index += 1) {
      const iteration = AgentIteration.make(index);
      const roundDecision = yield* acceptModelRound(
        yield* generateCurrentTurn(model, {
          turn,
          continuation,
          malformedOutputFeedback: feedback,
          remainingToolCalls: turn.limits.maxToolCallsPerTurn - toolCalls,
        })
      );
      if (roundDecision._tag === "Retry") {
        feedback = Option.some(roundDecision.feedback);
        continue;
      }
      feedback = Option.none();
      const { generated } = roundDecision;

      if (generated.toolCalls.length > turn.limits.maxToolCallsPerTurn - toolCalls) break;
      toolCalls += generated.toolCalls.length;

      const response = yield* respondToGeneration(turn, iteration, generated);
      if (response._tag === "Completed") return iterationReply(turn, iteration, response.text);
      continuation = yield* preserveModelContinuation({
        turn,
        iteration,
        generated,
        continuation,
      });
    }

    return iterationReply(turn, AgentIteration.make(turn.limits.maxIterations), exhaustedReply);
  });

const makePrepareTurn = (
  model: LanguageModel.Service,
  telemetry: TelemetryService
): ((
  userId: UserId,
  message: InboundMessage
) => Effect.Effect<
  PreparedAgentReply,
  AgentTurnError,
  Crypto.Crypto | HttpClient.HttpClient | SqlClient.SqlClient
>) =>
  Effect.fn("AgentService.prepareTurn")(function* (userId: UserId, message: InboundMessage) {
    const limits = yield* CurrentAgentLimits;
    const { user, confirmation } = yield* loadTurnContext(userId, message);
    if (containsSensitiveChatValue(message.text)) {
      return preparedReply(makeTextReply(credentialRejectedReply), Option.none());
    }
    const turnId = yield* makeTurnId;
    const occurredAt = yield* DateTime.now;
    const userEntry = UserTranscriptEntry.make({
      id: yield* makeEntryId,
      turnId,
      text: message.text,
      occurredAt,
    });
    yield* appendAuthorizedTranscript(userId, [userEntry]);
    const hostedToken = yield* withCurrentConsent(
      userId,
      issueHostedAgentToken(userId, occurredAt)
    );
    const runTurn = Effect.scoped(
      Effect.gen(function* () {
        const toolkit = yield* makeAgentToolkit(hostedToken.bearer);
        return yield* runHostedTurn(model, {
          userId,
          turnId,
          user,
          startedAt: occurredAt,
          limits,
          confirmation,
          toolkit,
        });
      })
    );

    return yield* runTurn.pipe(
      Effect.ensuring(
        DateTime.now.pipe(
          Effect.flatMap((revokedAt) =>
            revokeHostedAgentToken(userId, hostedToken.tokenId, revokedAt)
          )
        )
      ),
      Effect.provideService(Telemetry, telemetry)
    );
  });

const makeAgentService = Effect.gen(function* () {
  const model = yield* LanguageModel.LanguageModel;
  const crypto = yield* Crypto.Crypto;
  const sqlClient = yield* SqlClient.SqlClient;
  const telemetry = yield* Telemetry;

  const prepareTurn = makePrepareTurn(model, telemetry);

  const recordDeliveredReply = Effect.fn("AgentService.recordDeliveredReply")(
    (prepared: PreparedAgentReply) =>
      Option.match(prepared.assistantEntry, {
        onNone: () => Effect.void,
        onSome: (entry) => appendAssistantTranscript({ ...entry, text: prepared.reply.text }),
      }).pipe(
        Effect.provideService(Crypto.Crypto, crypto),
        Effect.provideService(SqlClient.SqlClient, sqlClient)
      )
  );
  const handleSynchronousTurn = Effect.fn("AgentService.handleSynchronousTurn")(function* (
    userId: UserId,
    message: InboundMessage
  ) {
    const prepared = yield* prepareTurn(userId, message);
    yield* recordDeliveredReply(prepared);
    return prepared.reply;
  });

  return AgentService.of({
    handleTurn: prepareTurn,
    handleSynchronousTurn,
    recordDeliveredReply,
  });
});

/**
 * Runs one hosted turn for the stable User identified by `userId`. `handleTurn` prepares the reply
 * for an asynchronous adapter; that adapter records it only after delivery. `handleSynchronousTurn`
 * prepares and immediately records a locally delivered reply. Accepted User text and canonical
 * calls/results may commit before delivery or a later model failure. Current onboarding consent is
 * required before Transcript, authorization, or model work. Missing consent, unknown Users, and
 * model failures are returned as AgentTurnError values; persistence, HTTP, and crypto defects
 * remain effects for the assembled runtime rather than user-visible replies.
 */
export class AgentService extends Context.Service<
  AgentService,
  {
    readonly handleTurn: (
      userId: UserId,
      message: InboundMessage
    ) => Effect.Effect<
      PreparedAgentReply,
      AgentTurnError,
      Crypto.Crypto | HttpClient.HttpClient | SqlClient.SqlClient
    >;
    readonly handleSynchronousTurn: (
      userId: UserId,
      message: InboundMessage
    ) => Effect.Effect<
      AgentReply,
      AgentTurnError,
      Crypto.Crypto | HttpClient.HttpClient | SqlClient.SqlClient
    >;
    readonly recordDeliveredReply: (
      prepared: PreparedAgentReply
    ) => Effect.Effect<void, OnboardingConsentRequired>;
  }
>()("fidy-ai/shell/agent/agent-service/AgentService") {
  /** Constructs the hosted agent from the external model and persistent slice seams. */
  static readonly layer = Layer.effect(this, makeAgentService);
}
