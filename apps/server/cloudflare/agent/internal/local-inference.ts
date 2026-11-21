import { readLocalSubscriptionOffers } from "../../subscription/operations";
import { reserveBatchForwarding } from "../../ingestion/operations";
import { getAtomicBatchInputSchema } from "../../../src/shell/operations/contract";
import { captureWithoutCommit } from "./capture-reply";
import { HostedToolAction, committedAnswer, failedQueryReply } from "./tool-reply";
import { documentReply } from "./local-document-reply";
import { takeChallenge, visibleChallenge } from "./local-challenge";
import { guardModelConfirmationReply, isHostedConfirmationAttempt } from "./hosted-confirmation";
import { compact, continuity } from "./local-compaction";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, Data, DateTime, Effect, Option, Predicate, Result, Schema } from "effect";
import {
  ProactiveInsightTranscriptEntry,
  TranscriptText,
  maximumHostedTurnIterations,
  maximumToolCallsPerTurn,
} from "../../../src/core/agent/contract";
import { MemoryText } from "../../../src/core/memory/contract";
import {
  HostedInferenceError,
  type HostedInferenceFailureReason,
  type HostedInferenceService,
  type HostedTextResult,
  type HostedTextToolCall,
  HostedToolCallMaximum,
  type PreparedHostedText,
} from "../../../src/shell/hosted-inference/contract";
import type { OpenAiEnvironment } from "../../ai/contract";
import { makeLocalHostedInference } from "../../ai/runtime";
import {
  chargeLocalProvider,
  reserveSharedProviderSpend,
} from "../../resource-admission/operations";
import { localHostedCatalog } from "../../canonical-operations/operations";
import { preserveStoreAlarm, withStoreCapacity } from "../../runtime/sqlite/operations";
import { AgentUnavailable } from "../contract";
import { assembleWorkingContext } from "./working-context";
import { type LocalTurn, channelAuthority } from "./local-turn";
import {
  channelReply,
  channelStatus,
  isResponse,
  liveTurn,
  propose,
  unavailable,
} from "./local-turn-store";
import { applyTool } from "./local-tool";

const FailureReason = Data.taggedEnum<HostedInferenceFailureReason>();

type Environment = OpenAiEnvironment & {
  DIRECTORY: Pick<DurableObjectNamespace, "getByName">;
  PRICING: Pick<DurableObjectNamespace, "getByName">;
  BROWSER_ORIGIN: string;
};

const contextFor = Effect.fn(function* (turn: LocalTurn, state: "queued" | "running" = "running") {
  const sql = yield* SqliteClient;
  const user = yield* liveTurn(turn, yield* Clock.currentTimeMillis, state);

  const memories = yield* Schema.decodeUnknownEffect(
    Schema.Array(Schema.Struct({ text: MemoryText }))
  )(yield* sql`SELECT text FROM memories WHERE user_id=${turn.user_id} ORDER BY created_at_ms,id`);

  const { summary, rows } = yield* continuity(turn, state === "queued" ? "prefix" : "full");

  const [reply] =
    yield* sql`SELECT p.entry_json FROM hosted_whatsapp_inbound i JOIN whatsapp_deliveries w ON w.user_id=i.user_id AND w.portfolio=i.portfolio AND w.bsuid=i.bsuid AND w.endpoint=i.endpoint AND w.provider_message_id=i.reply_to AND w.state='delivered' AND w.family='proactivity' JOIN proactive_transcript p ON p.user_id=w.user_id AND p.id=w.operation_id WHERE i.turn_id=${turn.id} AND i.user_id=${turn.user_id} AND p.occurred_ms<=i.occurred_ms+999`;

  const referred = Option.flatMap(
    Option.fromUndefinedOr(reply?.entry_json),
    Schema.decodeUnknownOption(
      Schema.fromJsonString(Schema.toCodecJson(ProactiveInsightTranscriptEntry))
    )
  );

  const session = { sessionId: turn.session_id, userId: turn.user_id };

  return assembleWorkingContext({
    ...session,
    activeTurnId: turn.id,
    user,
    channel: Option.isNone(turn.browser_id) ? "whatsapp" : "web",
    startedAt: DateTime.makeUnsafe(turn.start_ms),
    memories,
    compactedConversation: Option.map(Option.fromNullishOr(summary.text), (text) => ({
      ...session,
      text,
    })),
    transcript: rows.map((row) => ({
      ...session,
      sequence: BigInt(row.sequence),
      entry: row.entry_json,
    })),
    proactiveReply: Option.map(referred, (entry) => ({ userId: turn.user_id, entry })),
    activeRequest: turn.request_text,
  });
});

export const validateAdmission = Effect.fn(function* (
  environment: OpenAiEnvironment,
  turn: LocalTurn | Response
) {
  if (isResponse(turn)) return turn;

  if (!isHostedConfirmationAttempt(turn.request_text)) {
    const inference = yield* makeLocalHostedInference({
      environment,
      admit: () => Effect.succeed(false),
    });

    yield* inference.validateText({
      context: yield* contextFor(turn, "queued"),
      toolChoice: "auto",
      maximumToolCalls: HostedToolCallMaximum.make(maximumToolCallsPerTurn),
      availableOperations: localHostedCatalog(channelAuthority(turn)).map(
        (operation) => operation.id
      ),
    });
  }

  return channelReply(channelStatus.accepted)({ status: "processing", turnId: turn.id });
});

export const preflightRefusal = (error: HostedInferenceError): Response =>
  ["CapacityExceeded", "ActiveRequestCapacityExceeded", "ResourceLimit"].includes(error.reason._tag)
    ? channelReply(channelStatus.quota)({ status: "capacity_exceeded" })
    : unavailable();

const modelFor = Effect.fn(function* (env: Environment, turn: LocalTurn) {
  const claim = Effect.fn(
    function* (units: number) {
      const work = { phase: "model" as const, units };
      yield* liveTurn(turn, yield* Clock.currentTimeMillis);

      if (!(yield* reserveSharedProviderSpend(env.DIRECTORY, work))) return false;

      return yield* Effect.gen(function* () {
        const current = yield* Clock.currentTimeMillis;
        yield* liveTurn(turn, current);

        return yield* chargeLocalProvider(work, "user", current);
      }).pipe(withStoreCapacity("required"));
    },
    Effect.tapError(Effect.logDebug),
    Effect.mapError(
      () =>
        new HostedInferenceError({
          reason: FailureReason.AdmissionUnavailable(),
          retryable: false,
          retryAfter: Option.none(),
        })
    )
  );

  const scoped = yield* Effect.context<Effect.Services<ReturnType<typeof claim>>>();

  return yield* makeLocalHostedInference({
    environment: env,
    admit: (units) => claim(units).pipe(Effect.provide(scoped)),
  });
});

const present = Effect.fn(function* (
  turn: LocalTurn,
  reply: { text: TranscriptText; iteration: number },
  storage: DurableObjectStorage
) {
  const until = yield* propose(turn, reply.text, reply.iteration);
  yield* preserveStoreAlarm(storage, until);
});

const confirm = Effect.fn(function* (turn: LocalTurn, storage: DurableObjectStorage) {
  const held = yield* takeChallenge(turn);

  let text = TranscriptText.make(
    "La confirmación ya no está disponible. Vuelve a solicitar la operación para revisar sus detalles."
  );

  if (Option.isSome(held)) {
    const action = held.value;

    const result = yield* applyTool(
      { id: "confirm:" + turn.id, operation: action.operation, params: action.input_json },
      { turn, iteration: 1, storage, confirmed: action }
    );

    if (Predicate.isTagged(result.outcome, "Succeeded")) {
      text = TranscriptText.make("Se confirmó y completó la operación.");
    }
  }

  yield* present(turn, { text, iteration: 1 }, storage);
});

type ToolRound = { turn: LocalTurn; iteration: number; storage: DurableObjectStorage };

type ToolResult = Data.TaggedEnum.Value<HostedToolAction, "Result">;

const finishActions = Effect.fn(function* (
  actions: ReadonlyArray<ToolResult>,
  { turn, iteration, storage }: ToolRound
) {
  if (actions.some((action) => action.mutationSucceeded)) {
    yield* Effect.gen(function* () {
      const user = yield* liveTurn(turn, yield* Clock.currentTimeMillis);
      yield* present(
        turn,
        {
          text: committedAnswer({ actions: Option.some(actions), timeZone: user.timeZone }),
          iteration,
        },
        storage
      );
    }).pipe(withStoreCapacity("required"));

    return true;
  }

  const refused = Option.isNone(turn.browser_id) ? failedQueryReply(actions) : Option.none();

  if (Option.isSome(refused)) {
    yield* present(turn, { text: refused.value, iteration }, storage).pipe(
      withStoreCapacity("required")
    );

    return true;
  }

  return false;
});

const invalidToolGroup = (
  calls: ReadonlyArray<HostedTextToolCall>,
  catalog: ReturnType<typeof localHostedCatalog>
): boolean =>
  new Set(calls.map((tool) => tool.id)).size !== calls.length ||
  (calls.length > 1 &&
    calls.some(
      (tool) =>
        catalog.find((op) => op.id === tool.operation)?.policy.agentConfirmation === "required"
    ));

const reserveToolRoutes = Effect.fn(function* (
  tool: HostedTextToolCall,
  turn: LocalTurn,
  directory: Environment["DIRECTORY"]
) {
  const enable = "ingestion.enableEmailForwarding";

  const batch =
    tool.operation === "operations.executeAtomicBatch"
      ? Schema.decodeUnknownOption(Schema.Struct({ payload: getAtomicBatchInputSchema() }), {
          onExcessProperty: "error",
        })(tool.params)
      : Option.none();

  if (
    tool.operation === "ingestion.getEmailForwarding" ||
    tool.operation === enable ||
    Option.exists(batch, ({ payload }) => payload.calls.some((child) => child.operation === enable))
  ) {
    yield* liveTurn(turn, yield* Clock.currentTimeMillis).pipe(withStoreCapacity("required"));
    yield* reserveBatchForwarding(turn.user_id, directory);
  }
});

const applyToolCall = Effect.fn(function* (
  tool: HostedTextToolCall,
  round: ToolRound,
  env: Environment
) {
  const { turn, iteration, storage } = round;
  const catalog = localHostedCatalog(channelAuthority(turn));
  yield* reserveToolRoutes(tool, turn, env.DIRECTORY);

  const offers =
    tool.operation === "subscription.listSubscriptionOffers"
      ? yield* readLocalSubscriptionOffers(env.PRICING).pipe(Effect.option)
      : Option.none();

  const applied = yield* Effect.gen(function* () {
    const event = yield* applyTool(tool, {
      turn,
      iteration,
      storage,
      commercial: { origin: env.BROWSER_ORIGIN, offers },
    });

    const challenge = yield* visibleChallenge(turn.id, yield* Clock.currentTimeMillis);

    if (Option.isSome(challenge)) {
      yield* present(turn, { text: challenge.value.effect, iteration }, storage);
    }

    return { event, presented: Option.isSome(challenge) };
  }).pipe(withStoreCapacity("growth"));

  if (applied.presented) return Option.none<ToolResult>();

  return Option.some(
    HostedToolAction.Result({
      event: applied.event,
      mutationSucceeded:
        Predicate.isTagged(applied.event.outcome, "Succeeded") &&
        catalog.find((op) => op.id === tool.operation)?.policy.kind === "mutation",
    })
  );
});

const runTools = Effect.fn(function* (
  calls: ReadonlyArray<HostedTextToolCall>,
  round: ToolRound,
  env: Environment
) {
  const catalog = localHostedCatalog(channelAuthority(round.turn));

  if (invalidToolGroup(calls, catalog)) return yield* new AgentUnavailable();

  const applied = yield* Effect.reduce(
    calls,
    () => Option.some<ReadonlyArray<ToolResult>>([]),
    (actions, tool) =>
      Option.match(actions, {
        onNone: () => Effect.succeedNone,
        onSome: (prior) =>
          applyToolCall(tool, round, env).pipe(
            Effect.map(Option.map((action) => [...prior, action]))
          ),
      })
  );

  if (Option.isNone(applied)) return Option.none();

  if (yield* finishActions(applied.value, round)) return Option.none();

  return Option.some(applied.value.map(({ event }) => event));
});

type RoundProgress = { repairUsed: boolean; mutationAttempted: boolean };

type RoundStep = Data.TaggedEnum<{
  Result: { readonly output: HostedTextResult };
  Retry: { readonly prepared: PreparedHostedText };
  Proposed: {};
}>;

const RoundStep = Data.taggedEnum<RoundStep>();

const canRepair = (reason: string, round: ToolRound, previous: RoundProgress): boolean =>
  !previous.repairUsed &&
  reason === "InvalidOutput" &&
  (Option.isNone(round.turn.browser_id) || round.iteration === 1);

const providerRound = Effect.fn(function* (
  prepared: PreparedHostedText,
  round: ToolRound,
  previous: RoundProgress
) {
  const { turn, iteration, storage } = round;
  const result = yield* Effect.result(prepared.execute);

  if (Result.isSuccess(result)) return RoundStep.Result({ output: result.success });
  const reason = result.failure.reason._tag;

  if (previous.mutationAttempted) return yield* result.failure;

  if (canRepair(reason, round, previous)) {
    previous.repairUsed = true;
    const repair = yield* Effect.result(prepared.repairInvalidOutput);

    if (Result.isSuccess(repair)) return RoundStep.Retry({ prepared: repair.success });
  }

  if (
    Option.isNone(turn.browser_id) &&
    ["ProviderQuotaExceeded", "ProviderUnavailable", "InvalidOutput"].includes(reason)
  ) {
    yield* present(
      turn,
      {
        text: TranscriptText.make(
          "No pude completar tu solicitud en este momento. Inténtalo más tarde."
        ),
        iteration,
      },
      storage
    ).pipe(withStoreCapacity("required"));

    return RoundStep.Proposed();
  }

  return yield* result.failure;
});

const finishReply = Effect.fn(function* (
  result: HostedTextResult,
  { turn, storage, iteration }: ToolRound
) {
  if (result.finishReason !== "stop") return yield* new AgentUnavailable();
  const answer = yield* Schema.decodeUnknownEffect(TranscriptText)(result.text);

  return yield* present(
    turn,
    {
      text: Option.getOrElse(captureWithoutCommit({ request: turn.request_text }), () =>
        guardModelConfirmationReply(answer)
      ),
      iteration,
    },
    storage
  ).pipe(withStoreCapacity("required"));
});

const validToolRound = (result: HostedTextResult, total: number): boolean =>
  result.finishReason === "tool-calls" && total <= maximumToolCallsPerTurn;

const includesMutation = (
  calls: ReadonlyArray<HostedTextToolCall>,
  catalog: ReturnType<typeof localHostedCatalog>
): boolean =>
  calls.some((tool) => catalog.find((op) => op.id === tool.operation)?.policy.kind === "mutation");

type RoundState = {
  prepared: PreparedHostedText;
  iteration: number;
  total: number;
  settled: boolean;
  previous: RoundProgress;
};

type RoundScope = {
  turn: LocalTurn;
  storage: DurableObjectStorage;
  env: Environment;
  catalog: ReturnType<typeof localHostedCatalog>;
};

const completeRound = Effect.fn(function* (
  result: HostedTextResult,
  rounds: RoundState,
  { turn, storage, env, catalog }: RoundScope
) {
  const { iteration } = rounds;

  if (result.toolCalls.length === 0) {
    yield* finishReply(result, { turn, storage, iteration });
    rounds.settled = true;

    return;
  }

  rounds.total += result.toolCalls.length;

  if (!validToolRound(result, rounds.total)) {
    return yield* new AgentUnavailable();
  }

  rounds.previous.mutationAttempted ||= includesMutation(result.toolCalls, catalog);
  const events = yield* runTools(result.toolCalls, { turn, iteration, storage }, env);

  if (Option.isNone(events)) {
    rounds.settled = true;

    return;
  }

  rounds.prepared = yield* result.continuation.prepare(events.value);
});

const advanceRound = Effect.fn(function* (rounds: RoundState, scope: RoundScope) {
  const step = yield* providerRound(
    rounds.prepared,
    { turn: scope.turn, storage: scope.storage, iteration: rounds.iteration },
    rounds.previous
  );

  return yield* RoundStep.$match(step, {
    Proposed: () =>
      Effect.sync(() => {
        rounds.settled = true;
      }),
    Retry: ({ prepared }) =>
      Effect.sync(() => {
        rounds.prepared = prepared;
      }),
    Result: ({ output }) => completeRound(output, rounds, scope),
  });
});

const runRounds = Effect.fn(function* (
  inference: HostedInferenceService,
  turn: LocalTurn,
  { storage, env }: { storage: DurableObjectStorage; env: Environment }
) {
  const context = yield* contextFor(turn).pipe(withStoreCapacity("required"));
  const catalog = localHostedCatalog(channelAuthority(turn));

  const prepared = yield* inference.prepareText({
    context,
    toolChoice: "auto",
    maximumToolCalls: HostedToolCallMaximum.make(maximumToolCallsPerTurn),
    availableOperations: catalog.map((op) => op.id),
  });

  const rounds: RoundState = {
    prepared,
    iteration: 1,
    total: 0,
    settled: false,
    previous: { repairUsed: false, mutationAttempted: false },
  };

  yield* Effect.whileLoop({
    while: () => !rounds.settled && rounds.iteration <= maximumHostedTurnIterations,
    body: () => advanceRound(rounds, { turn, storage, env, catalog }),
    step: () => {
      rounds.iteration++;
    },
  });

  if (!rounds.settled) return yield* new AgentUnavailable();
});

export const executeTurn = Effect.fn(function* (
  env: Environment,
  turn: LocalTurn,
  storage: DurableObjectStorage
) {
  if (
    Option.isNone(turn.browser_id) &&
    (yield* documentReply(turn, storage).pipe(withStoreCapacity("required")))
  ) {
    return;
  }

  if (isHostedConfirmationAttempt(turn.request_text)) {
    return yield* confirm(turn, storage).pipe(withStoreCapacity("growth"));
  }

  const inference = yield* modelFor(env, turn);
  yield* compact(turn, inference).pipe(Effect.ignore);
  yield* runRounds(inference, turn, { storage, env });
});
