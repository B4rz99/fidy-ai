import {
  Context,
  Crypto,
  Data,
  DateTime,
  Effect,
  Layer,
  Option,
  Result,
  Schema,
  Stream,
  Struct,
} from "effect";
import { LanguageModel } from "effect/unstable/ai";
import type { HttpClient } from "effect/unstable/http";
import { SqlClient } from "effect/unstable/sql";
import type { UserId } from "~/core/identity/reference";
import {
  selectTranscriptWindow,
  TranscriptWindowCharacterLimit,
  TranscriptWindowTurnLimit,
} from "~/core/transcript/rules";
import {
  AgentIteration,
  AssistantTranscriptEntry,
  CanonicalToolCallEntry,
  CanonicalToolResultEntry,
  type CanonicalToolOutcome,
  type TranscriptEntry,
  TranscriptEntryId,
  TranscriptText,
  TranscriptTurnId,
  ToolCallId,
  UserTranscriptEntry,
} from "~/core/transcript/model";
import { ValidationFailed } from "~/shell/_shared/errors";
import { useCurrentConsent } from "~/shell/consent/repo";
import { findUser } from "~/shell/identity/repo";
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
} from "./model-boundary";
import { makeTurnConfirmation } from "./tool-confirmation";
import {
  type AgentOperationBinding,
  decodeAgentOperationInput,
  findAgentOperationBinding,
  makeAgentToolkit,
} from "./toolkit";

/** Resource and context bounds applied independently to every hosted turn. */
export const AgentLimits = Schema.Struct({
  maxIterations: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32 })),
  maxToolCallsPerTurn: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
  maxToolResultCharacters: Schema.Int.check(
    Schema.isBetween({ minimum: 1_000, maximum: 1_000_000 })
  ),
  maxTranscriptTurns: TranscriptWindowTurnLimit,
  maxTranscriptCharacters: TranscriptWindowCharacterLimit.check(
    Schema.isGreaterThanOrEqualTo(1_000)
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
        maxTranscriptTurns: TranscriptWindowTurnLimit.make(12),
        maxTranscriptCharacters: TranscriptWindowCharacterLimit.make(32_000),
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
}> {}

/** Failure returned before any model or transcript work when onboarding consent is absent. */
export class OnboardingConsentRequired extends Data.TaggedError("OnboardingConsentRequired")<{
  readonly userId: UserId;
}> {}

/** Safe failure returned when the configured language model cannot complete a turn. */
export class ModelUnavailable extends Data.TaggedError("ModelUnavailable")<{}> {}

/** Closed failure vocabulary exposed by the channel-agnostic turn boundary. */
export type AgentTurnError = UnknownUser | OnboardingConsentRequired | ModelUnavailable;

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
) => withCurrentConsent(subjectUserId, appendTranscriptEntries(subjectUserId, entries));

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
const exhaustedReply = TranscriptText.make(
  "No pude completar la solicitud dentro del límite seguro de operaciones. Intenta de nuevo."
);
const malformedToolInput: Schema.Json = {
  code: "tool_input_rejected",
  message: "The model supplied malformed operation input. Correct the fields before retrying.",
};
const malformedModelOutputFeedback =
  "The previous operation call was malformed and was not executed. Correct its arguments before retrying.";
const CanonicalValidationFailure = ValidationFailed.mapFields(Struct.pick(["error"]));

const toModelUnavailable = () => new ModelUnavailable();
const decodeTranscriptText = (value: unknown) =>
  Schema.decodeUnknownEffect(TranscriptText)(value).pipe(Effect.mapError(toModelUnavailable));
const decodeTranscriptJson = (value: unknown) =>
  Schema.decodeUnknownEffect(Schema.Json)(value).pipe(Effect.mapError(toModelUnavailable));
const encodeTranscriptJson = (
  schema: Schema.Codec<unknown, Schema.Json, never, never>,
  value: unknown
) =>
  Schema.encodeUnknownEffect(schema)(value).pipe(
    Effect.flatMap(decodeTranscriptJson),
    Effect.mapError(toModelUnavailable)
  );
const encodeAgentOperationInput = (binding: AgentOperationBinding, input: unknown) =>
  decodeAgentOperationInput({ binding, input }).pipe(
    Effect.flatMap((decoded) => encodeTranscriptJson(binding.parameters, decoded)),
    Effect.mapError(toModelUnavailable)
  );
const requireToolResult = function <A>(result: Option.Option<A>) {
  return Option.match(result, {
    onNone: () => Effect.fail(new ModelUnavailable()),
    onSome: (value) => Effect.succeed(value),
  });
};
const isTerminalToolResult = (result: { readonly preliminary: boolean }) =>
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

const makeAgentService = Effect.gen(function* () {
  const model = yield* LanguageModel.LanguageModel;
  const crypto = yield* Crypto.Crypto;
  const sqlClient = yield* SqlClient.SqlClient;
  const generateCurrent = ({
    includeMalformedOutputFeedback,
    limits,
    occurredAt,
    toolkit,
    turnId,
    user,
    userId,
  }: Readonly<{
    readonly includeMalformedOutputFeedback: boolean;
    readonly limits: AgentLimits;
    readonly occurredAt: DateTime.Utc;
    readonly toolkit: Effect.Success<ReturnType<typeof makeAgentToolkit>>;
    readonly turnId: TranscriptTurnId;
    readonly user: Parameters<typeof systemPrompt>[0]["user"];
    readonly userId: UserId;
  }>) =>
    Effect.gen(function* () {
      const priorTurns =
        limits.maxTranscriptTurns === 1
          ? Effect.succeed([])
          : listRecentTranscriptEntries(userId, limits.maxTranscriptTurns - 1);
      const transcriptWindow = yield* withCurrentConsent(
        userId,
        Effect.all({
          currentTranscript: listTranscriptTurnEntries(userId, turnId),
          priorTurns,
        }).pipe(
          Effect.map(({ currentTranscript, priorTurns: prior }) =>
            projectTranscriptForModel(
              [...prior, ...currentTranscript],
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
      return yield* Effect.result(
        model
          .generateText({
            prompt: [
              { role: "system", content: systemPrompt({ user, occurredAt }) },
              ...(includeMalformedOutputFeedback
                ? [{ role: "system" as const, content: malformedModelOutputFeedback }]
                : []),
              ...transcriptPrompt(transcriptWindow),
            ],
            toolkit,
            disableToolCallResolution: true,
          })
          .pipe(Effect.timeout(`${limits.maxModelRoundMillis} millis`))
      );
    });

  const prepareTurn = Effect.fn("AgentService.prepareTurn")(function* (
    userId: UserId,
    message: InboundMessage
  ) {
    const limits = yield* CurrentAgentLimits;
    const { user, confirmation } = yield* withCurrentConsent(
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
        let toolCalls = 0;
        let includeMalformedOutputFeedback = false;
        for (let index = 1; index <= limits.maxIterations; index += 1) {
          const iteration = AgentIteration.make(index);
          const generatedResult = yield* generateCurrent({
            includeMalformedOutputFeedback,
            limits,
            occurredAt,
            toolkit,
            turnId,
            user,
            userId,
          });
          if (Result.isFailure(generatedResult)) {
            if (
              !("reason" in generatedResult.failure) ||
              generatedResult.failure.reason._tag !== "InvalidOutputError"
            ) {
              return yield* new ModelUnavailable();
            }
            if (containsSensitiveChatValue(generatedResult.failure.reason.description)) {
              return yield* new ModelUnavailable();
            }
            includeMalformedOutputFeedback = true;
            continue;
          }
          includeMalformedOutputFeedback = false;
          const generated = generatedResult.success;

          if (generated.toolCalls.length > limits.maxToolCallsPerTurn - toolCalls) break;
          toolCalls += generated.toolCalls.length;

          if (generated.toolCalls.length === 0) {
            const decodedText = yield* decodeTranscriptText(generated.text);
            const text = containsSensitiveChatValue(decodedText)
              ? credentialRejectedReply
              : decodedText;
            return preparedReply(makeTextReply(text), Option.some({ userId, turnId, iteration }));
          }

          let pendingChallenge = Option.none<TranscriptText>();
          for (const toolCall of generated.toolCalls) {
            const binding = yield* findAgentOperationBinding(toolCall.name).pipe(
              Option.match({
                onNone: () => Effect.fail(new ModelUnavailable()),
                onSome: Effect.succeed,
              })
            );
            const toolCallId = ToolCallId.make(toolCall.id);
            const encodedInput = yield* Effect.result(
              encodeAgentOperationInput(binding, toolCall.params)
            );
            const input = yield* Result.match(encodedInput, {
              onFailure: () => decodeTranscriptJson(toolCall.params),
              onSuccess: Effect.succeed,
            });
            if (containsSensitiveJson(input)) return yield* new ModelUnavailable();
            yield* appendAuthorizedTranscript(userId, [
              CanonicalToolCallEntry.make({
                id: yield* makeEntryId,
                turnId,
                iteration,
                toolCallId,
                operation: binding.operation,
                input,
                occurredAt: yield* DateTime.now,
              }),
            ]);
            if (Result.isFailure(encodedInput)) {
              yield* appendAuthorizedTranscript(userId, [
                CanonicalToolResultEntry.make({
                  id: yield* makeEntryId,
                  turnId,
                  iteration,
                  toolCallId,
                  operation: binding.operation,
                  outcome: { _tag: "ToolInputRejected", failure: malformedToolInput },
                  occurredAt: yield* DateTime.now,
                }),
              ]);
              continue;
            }
            const confirmationDecision = yield* confirmation.decide({ binding, input });
            if (confirmationDecision._tag === "RequireConfirmation") {
              yield* appendAuthorizedTranscript(userId, [
                CanonicalToolResultEntry.make({
                  id: yield* makeEntryId,
                  turnId,
                  iteration,
                  toolCallId,
                  operation: binding.operation,
                  outcome: {
                    _tag: "ToolInputRejected",
                    failure: confirmationDecision.failure,
                  },
                  occurredAt: yield* DateTime.now,
                }),
              ]);
              pendingChallenge = Option.some(confirmationDecision.failure.challenge);
              continue;
            }

            const executed = yield* toolkit
              .handle(toolCall.name, input)
              .pipe(
                Stream.unwrap,
                Stream.filter(isTerminalToolResult),
                Stream.runLast,
                Effect.flatMap(requireToolResult),
                Effect.mapError(toModelUnavailable)
              );
            const result = yield* decodeTranscriptJson(executed.encodedResult);
            const outcome: CanonicalToolOutcome = containsSensitiveJson(result)
              ? { _tag: "ToolOutputRejected", failure: sensitiveEntryRejected }
              : makeToolOutcome(executed.isFailure, result);
            yield* appendAuthorizedTranscript(userId, [
              CanonicalToolResultEntry.make({
                id: yield* makeEntryId,
                turnId,
                iteration,
                toolCallId,
                operation: binding.operation,
                outcome,
                occurredAt: yield* DateTime.now,
              }),
            ]);
            if (binding.policy.requiredScope === "write" && outcome._tag === "Succeeded") {
              return preparedReply(
                makeTextReply(operationCompletedReply),
                Option.some({ userId, turnId, iteration })
              );
            }
          }
          if (Option.isSome(pendingChallenge)) {
            return preparedReply(
              makeTextReply(pendingChallenge.value),
              Option.some({ userId, turnId, iteration })
            );
          }
        }

        return preparedReply(
          makeTextReply(exhaustedReply),
          Option.some({
            userId,
            turnId,
            iteration: AgentIteration.make(limits.maxIterations),
          })
        );
      })
    );

    return yield* runTurn.pipe(
      Effect.ensuring(
        DateTime.now.pipe(
          Effect.flatMap((revokedAt) =>
            revokeHostedAgentToken(userId, hostedToken.tokenId, revokedAt)
          )
        )
      )
    );
  });

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
>()("fidy-ai/shell/agent/agent-service/AgentService") {}

/** Constructs the hosted agent from the external model and persistent slice seams. */
export const AgentServiceLive = Layer.effect(AgentService, makeAgentService);
