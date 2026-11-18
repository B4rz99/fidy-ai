import { captureWithoutCommit } from "./capture-reply";
import { type HostedToolAction, committedAnswer, failedQueryReply } from "./tool-reply";
import { documentReply } from "./local-document-reply";
import { takeChallenge, visibleChallenge } from "./local-challenge";
import { guardModelConfirmationReply, isHostedConfirmationAttempt } from "./hosted-confirmation";
import { compact, continuity } from "./local-compaction";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, DateTime, Effect, Option, Schema } from "effect";
import {
  ProactiveInsightTranscriptEntry,
  TranscriptText,
  maximumHostedTurnIterations,
  maximumToolCallsPerTurn,
} from "../../../src/core/agent/contract";
import { MemoryText } from "../../../src/core/memory/contract";
import {
  HostedInferenceError,
  type HostedInferenceService,
  type HostedTextToolCall,
  HostedToolCallMaximum,
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
import { channelReply, channelStatus, liveTurn, propose, unavailable } from "./local-turn-store";
import { applyTool } from "./local-tool";

type Environment = OpenAiEnvironment & { DIRECTORY: Pick<DurableObjectNamespace, "getByName"> };
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
  if (turn instanceof Response) return turn;
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
    Effect.mapError(
      () =>
        new HostedInferenceError({
          reason: { _tag: "AdmissionUnavailable" },
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
    if (result.outcome._tag === "Succeeded") {
      text = TranscriptText.make("Se confirmó y completó la operación.");
    }
  }
  yield* present(turn, { text, iteration: 1 }, storage);
});
type ToolRound = { turn: LocalTurn; iteration: number; storage: DurableObjectStorage };
type ToolResult = Extract<HostedToolAction, { _tag: "Result" }>;
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
const runTools = Effect.fn(function* (calls: ReadonlyArray<HostedTextToolCall>, round: ToolRound) {
  const { turn, iteration, storage } = round;
  const catalog = localHostedCatalog(channelAuthority(turn));
  if (invalidToolGroup(calls, catalog)) return yield* new AgentUnavailable();
  const actions: ToolResult[] = [];
  for (const tool of calls) {
    const applied = yield* Effect.gen(function* () {
      const event = yield* applyTool(tool, { turn, iteration, storage });
      const challenge = yield* visibleChallenge(turn.id, yield* Clock.currentTimeMillis);
      if (Option.isSome(challenge)) {
        yield* present(turn, { text: challenge.value.effect, iteration }, storage);
      }
      return { event, presented: Option.isSome(challenge) };
    }).pipe(withStoreCapacity("growth"));
    if (applied.presented) return Option.none();
    actions.push({
      _tag: "Result",
      event: applied.event,
      mutationSucceeded:
        applied.event.outcome._tag === "Succeeded" &&
        catalog.find((op) => op.id === tool.operation)?.policy.kind === "mutation",
    });
  }
  if (yield* finishActions(actions, round)) return Option.none();
  return Option.some(actions.map(({ event }) => event));
});
const runRounds = Effect.fn(function* (
  inference: HostedInferenceService,
  turn: LocalTurn,
  storage: DurableObjectStorage
) {
  const context = yield* contextFor(turn).pipe(withStoreCapacity("required"));
  const catalog = localHostedCatalog(channelAuthority(turn));
  let prepared = yield* inference.prepareText({
    context,
    toolChoice: "auto",
    maximumToolCalls: HostedToolCallMaximum.make(maximumToolCallsPerTurn),
    availableOperations: catalog.map((op) => op.id),
  });
  let total = 0;
  for (let iteration = 1; iteration <= maximumHostedTurnIterations; iteration++) {
    const result = yield* prepared.execute;
    if (result.toolCalls.length === 0) {
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
    }
    total += result.toolCalls.length;
    if (result.finishReason !== "tool-calls" || total > maximumToolCallsPerTurn) {
      return yield* new AgentUnavailable();
    }
    const events = yield* runTools(result.toolCalls, { turn, iteration, storage });
    if (Option.isNone(events)) return;
    prepared = yield* result.continuation.prepare(events.value);
  }
  return yield* new AgentUnavailable();
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
  yield* runRounds(inference, turn, storage);
});
