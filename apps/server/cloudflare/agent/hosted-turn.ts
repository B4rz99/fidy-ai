import {
  CanonicalToolCallEntry,
  CanonicalToolEvidence,
  CanonicalToolResultEntry,
  CompactedConversationOutput,
  ToolCallId,
  TranscriptEntryId,
  TranscriptText,
  TranscriptTurnId,
  UserId,
  assembleWorkingContext,
  compactionEntryTrigger,
  defaultCompactionMaximumTokens,
  shouldCompactConversation,
} from "@fidy/server/agent-runtime";
import type {
  HostedInferenceService,
  HostedTextResult,
  PreparedHostedText,
} from "@fidy/server/hosted-inference";
import { Cause, DateTime, Effect, Exit, Option, Schema } from "effect";
import { operationCatalog } from "@fidy/server/canonical-runtime";
import { HostedToolCallMaximum } from "@fidy/server/hosted-inference";
import { decideOperationAccess } from "../../src/shell/_shared/operation-policy";
import {
  maximumHostedTurnIterations,
  maximumToolCallsPerTurn,
} from "../../src/shell/_shared/hosted-turn-bounds";
import { executeProtectedCategories } from "../categories/canonical-category";
import { HostedTurnReceipt, HostedTurnRequest } from "../../src/shell/agent/hosted-turn-api";
import type { TransactionSubject } from "../transactions/transaction-boundary";
import { transactionNow } from "../transactions/transaction-boundary";
import { newId } from "../pats/pat-shared";
import {
  type HostedTurnOutcome,
  type HostedTurnSnapshot,
  acknowledgeHostedDelivery,
  admitHostedTurn,
  appendHostedToolEntry,
  commitHostedCompaction,
  deliveryAcknowledgmentWindowMs,
  finishHostedTurn,
  pendingExecutionRecoveryMs,
  readHostedContinuity,
  readHostedSnapshot,
  recoverHostedTurn,
  reserveHostedCompaction,
  selectHostedSession,
  stageHostedDelivery,
} from "./turn-store";

// The installed owner map is deliberately smaller than the canonical catalog: an operation is
// exposed only when this coordinator can execute it under the live WebSession authority.
const hostedExecutableOperations = operationCatalog.operations.filter(
  ({ id, policy }) =>
    id === "categories.listCategories" &&
    policy.kind === "query" &&
    policy.agentConfirmation === "not-required" &&
    decideOperationAccess(policy.access, {
      _tag: "HostedAgentSession",
      authorityRoot: "no-verified-whatsapp-authority",
    })._tag === "Allowed"
);

const noStore = { "cache-control": "no-store" } as const;
const unavailable = (): Response =>
  Response.json({ status: "unavailable" }, { status: 503, headers: noStore });
const unauthenticated = (): Response =>
  Response.json({ status: "unauthenticated" }, { status: 401, headers: noStore });
const consentRequired = (): Response =>
  Response.json({ status: "user_action_required" }, { status: 403, headers: noStore });
const invalid = (): Response =>
  Response.json({ status: "validation_failed" }, { status: 400, headers: noStore });
const interrupted = (): Response =>
  Response.json({ status: "interrupted" }, { status: 503, headers: noStore });

/** Construct a proposed reply. Only a separate browser-visible receipt permits completion. */
export type HostedDelivery = (
  proposal: Readonly<{
    text: TranscriptText;
    turnId: TranscriptTurnId;
    receipt: string;
  }>
) => Promise<Response>;

/** Return an inert reply for the authenticated browser to render before acknowledging it. */
export const browserHostedDelivery: HostedDelivery = ({ text, turnId, receipt }) =>
  Promise.resolve(Response.json({ text, turnId, receipt }, { status: 202, headers: noStore }));

type HostedTurnInput = Readonly<{
  db: D1Database;
  subject: TransactionSubject;
  text: TranscriptText;
  inference: HostedInferenceService;
  deliver: HostedDelivery;
  signal: AbortSignal;
  scheduleRecovery: (dueAtMs: number) => Promise<void>;
}>;

/**
 * Own one hosted Turn under the per-User Durable Object's serialized request. D1 owns
 * admission and exact evidence; the adapter owns bounded provider rounds and delivery. A lost
 * request after Pending is recovered by the next Turn, never silently reported Completed.
 */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const completeHostedTurn = async ({
  db,
  subject,
  text,
  inference,
  deliver,
  signal,
  scheduleRecovery,
}: HostedTurnInput): Promise<Response> => {
  const userId = UserId.make(subject.userId);
  const snapshot = await readAdmissibleSnapshot({ db, subject, userId });
  if (snapshot instanceof Response) return snapshot;
  const startedAtMs = transactionNow();
  const selection = selectHostedSession(snapshot, userId, startedAtMs);
  const activeTurnId = TranscriptTurnId.make(newId());
  const prepared = await prepareHostedWork({
    db,
    subject,
    selection,
    snapshot,
    userId,
    activeTurnId,
    startedAtMs,
    text,
    inference,
    signal,
  });
  if (Option.isNone(prepared)) return unavailable();
  const turn = await admitHostedTurn({
    db,
    subject,
    selection,
    text,
    now: startedAtMs,
    id: activeTurnId,
  });
  if (Option.isNone(turn)) return unauthenticated();
  await scheduleRecovery(startedAtMs + pendingExecutionRecoveryMs);
  return executeAdmittedTurn({
    db,
    userId,
    turnId: turn.value,
    subject,
    startedAtMs,
    prepared: prepared.value,
    deliver,
    signal,
    scheduleRecovery,
  });
};

// @effect-diagnostics-next-line asyncFunction:off
const readAdmissibleSnapshot = async ({
  db,
  subject,
  userId,
}: Readonly<{
  db: D1Database;
  subject: TransactionSubject;
  userId: UserId;
}>): Promise<HostedTurnSnapshot | Response> => {
  const current = transactionNow();
  const initial = await readHostedSnapshot(db, subject, current);
  if (Option.isNone(initial)) return unauthenticated();
  const recovered = await recoverPending({
    db,
    userId,
    pending: initial.value.pending,
    now: current,
  });
  if (recovered === "awaiting") {
    return Response.json({ status: "awaiting_delivery" }, { status: 409, headers: noStore });
  }
  if (recovered === "error") return unavailable();
  const fresh = await readHostedSnapshot(db, subject, transactionNow());
  if (Option.isNone(fresh)) return unauthenticated();
  if (fresh.value.revoked) return consentRequired();
  if (!fresh.value.capacityAvailable) {
    return Response.json({ status: "capacity_exceeded" }, { status: 429, headers: noStore });
  }
  return fresh.value;
};

type WorkPreflight = Readonly<{
  db: D1Database;
  subject: TransactionSubject;
  selection: ReturnType<typeof selectHostedSession>;
  snapshot: HostedTurnSnapshot;
  userId: UserId;
  activeTurnId: TranscriptTurnId;
  startedAtMs: number;
  text: TranscriptText;
  inference: HostedInferenceService;
  signal: AbortSignal;
}>;

/** Check the complete semantic request before any Pending or User evidence can be written. */
// @effect-diagnostics-next-line asyncFunction:off
const prepareHostedWork = async ({
  db,
  subject,
  selection,
  snapshot,
  userId,
  activeTurnId,
  startedAtMs,
  text,
  inference,
  signal,
}: WorkPreflight): Promise<Option.Option<PreparedHostedText>> => {
  const initial = await readHostedContinuity({
    db,
    subject,
    sessionId: selection.id,
    now: startedAtMs,
  });
  const continuity = await compactHostedContinuity({
    db,
    subject,
    sessionId: selection.id,
    now: startedAtMs,
    inference,
    initial,
    signal,
  });
  const context = assembleWorkingContext({
    sessionId: selection.id,
    userId,
    activeTurnId,
    user: snapshot.user,
    startedAt: DateTime.makeUnsafe(startedAtMs),
    memories: continuity.memories,
    compactedConversation: continuity.compactedConversation,
    transcript: continuity.transcript,
    activeRequest: text,
  });
  const prepared = await Effect.runPromiseExit(
    inference.prepareText({
      context,
      toolChoice: "auto",
      maximumToolCalls: HostedToolCallMaximum.make(maximumToolCallsPerTurn),
      availableOperations: hostedExecutableOperations.map(({ id }) => id),
    }),
    { signal }
  );
  return Exit.isFailure(prepared) || signal.aborted ? Option.none() : Option.some(prepared.value);
};

type HostedContinuity = Awaited<ReturnType<typeof readHostedContinuity>>;

/** Best-effort replacement: failure cannot delete evidence or invalidate existing continuity. */
// No new telemetry: this optional preflight shares the Turn's bounded provider work; existing
// provider telemetry observes its execution. Failures are contained without reporting User content.
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
const compactHostedContinuity = async ({
  db,
  subject,
  sessionId,
  now,
  inference,
  initial,
  signal,
}: Readonly<{
  db: D1Database;
  subject: TransactionSubject;
  sessionId: ReturnType<typeof selectHostedSession>["id"];
  now: number;
  inference: HostedInferenceService;
  initial: HostedContinuity;
  signal: AbortSignal;
}>): Promise<HostedContinuity> => {
  const wasAborted = (): boolean => signal.aborted;
  const prefix = initial.transcript.filter((entry) =>
    Option.exists(initial.terminalThroughSequence, (cursor) => entry.sequence <= BigInt(cursor))
  );
  if (prefix.length === 0 || wasAborted()) {
    return initial;
  }
  const nearEntryCapacity = initial.transcript.length >= compactionEntryTrigger;
  const counted = nearEntryCapacity
    ? Option.none()
    : Option.some(
        await Effect.runPromiseExit(
          inference.countTranscript(initial.transcript.map(({ entry }) => entry)),
          { signal }
        )
      );
  if (
    (!nearEntryCapacity &&
      !Option.exists(
        counted,
        (result) =>
          Exit.isSuccess(result) &&
          shouldCompactConversation({
            entryCount: initial.transcript.length,
            tokenCount: result.value,
          })
      )) ||
    wasAborted()
  ) {
    return initial;
  }
  if (!(await reserveHostedCompaction({ db, subject, sessionId }))) {
    return initial;
  }
  const prepared = await Effect.runPromiseExit(
    inference.prepareStructured({
      purpose: "conversation-compaction",
      context: {
        prior: Option.map(initial.compactedConversation, ({ text }) => text),
        entries: prefix.map(({ entry }) => entry),
      },
      outputSchema: CompactedConversationOutput,
    }),
    { signal }
  );
  if (Exit.isFailure(prepared) || wasAborted()) {
    return initial;
  }
  const generated = await Effect.runPromiseExit(prepared.value.execute, { signal });
  if (Exit.isFailure(generated) || wasAborted()) {
    return initial;
  }
  const tokens = await Effect.runPromiseExit(
    inference.countText(generated.value.compactedConversation),
    { signal }
  );
  if (Exit.isFailure(tokens) || tokens.value > defaultCompactionMaximumTokens || wasAborted()) {
    return initial;
  }
  const last = prefix.at(-1);
  if (last === undefined) {
    return initial;
  }
  const saved = await commitHostedCompaction({
    db,
    subject,
    sessionId,
    continuity: initial,
    throughSequence: Number(last.sequence),
    text: generated.value.compactedConversation,
    signal,
  });
  return saved ? readHostedContinuity({ db, subject, sessionId, now }) : initial;
};

const recoverPending = ({
  db,
  userId,
  pending,
  now,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  pending: Option.Option<Parameters<typeof recoverHostedTurn>[0]["turn"]>;
  now: number;
}>): Promise<"clear" | "awaiting" | "error"> => {
  if (Option.isNone(pending)) return Promise.resolve("clear");
  if (
    pending.value.proposed_at_ms !== null &&
    now - pending.value.proposed_at_ms < deliveryAcknowledgmentWindowMs
  ) {
    return Promise.resolve("awaiting");
  }
  return recoverHostedTurn({ db, userId, turn: pending.value, now }).then((recovered) =>
    recovered ? ("clear" as const) : ("error" as const)
  );
};

type AdmittedWork = Readonly<{
  db: D1Database;
  userId: UserId;
  subject: TransactionSubject;
  turnId: TranscriptTurnId;
  startedAtMs: number;
  prepared: PreparedHostedText;
  deliver: HostedDelivery;
  signal: AbortSignal;
  scheduleRecovery: (dueAtMs: number) => Promise<void>;
}>;

/** The only path allowed to terminalize a Pending Turn. */
// @effect-diagnostics-next-line asyncFunction:off
const executeAdmittedTurn = async ({
  db,
  userId,
  turnId,
  subject,
  startedAtMs,
  prepared,
  deliver,
  signal,
  scheduleRecovery,
}: AdmittedWork): Promise<Response> => {
  const finish = (result: HostedTurnOutcome): Promise<boolean> =>
    finishHostedTurn({ db, userId, turnId, startedAtMs, result, subject, now: transactionNow() });
  const seenCalls = new Set<string>();
  // Each continuation is one-shot; the next round starts only after every result is retained.
  // @effect-diagnostics-next-line asyncFunction:off
  const executeRound = async (
    active: PreparedHostedText,
    iteration: number,
    usedCalls: number
  ): Promise<Response> => {
    if (iteration > maximumHostedTurnIterations) {
      await finish({ _tag: "Failed", reason: "HostedInferenceFailed" });
      return unavailable();
    }
    const generated = await Effect.runPromiseExit(
      active.execute.pipe(Effect.timeout("120 seconds")),
      {
        signal,
      }
    );
    if (signal.aborted || (Exit.isFailure(generated) && Cause.hasInterrupts(generated.cause))) {
      return (await finish({ _tag: "Interrupted" })) ? interrupted() : unavailable();
    }
    if (Exit.isFailure(generated)) {
      const timedOut = Option.exists(Cause.findErrorOption(generated.cause), Cause.isTimeoutError);
      await finish({
        _tag: "Failed",
        reason: timedOut ? "HostedInferenceTimedOut" : "HostedInferenceFailed",
      });
      return unavailable();
    }
    if (generated.value.toolCalls.length > 0) {
      const nextCount = usedCalls + generated.value.toolCalls.length;
      const ids = generated.value.toolCalls.map(({ id }) => id);
      const duplicate = ids.some((id) => seenCalls.has(id)) || new Set(ids).size !== ids.length;
      if (
        nextCount > maximumToolCallsPerTurn ||
        generated.value.finishReason !== "tool-calls" ||
        duplicate
      ) {
        await finish({ _tag: "Failed", reason: "HostedInferenceFailed" });
        return unavailable();
      }
      const events = await generated.value.toolCalls.reduce<
        Promise<Option.Option<ReadonlyArray<HostedToolEvent>>>
      >(
        // @effect-diagnostics-next-line asyncFunction:off
        async (previous, call) => {
          const prior = await previous;
          if (Option.isNone(prior)) return prior;
          seenCalls.add(call.id);
          const result = await executeHostedTool({ db, subject, userId, turnId, call, iteration });
          return Option.map(result, (event) => [...prior.value, event]);
        },
        Promise.resolve(Option.some([]))
      );
      if (Option.isNone(events)) {
        await finish({ _tag: "Failed", reason: "HostedInferenceFailed" });
        return unavailable();
      }
      const next = await Effect.runPromiseExit(generated.value.continuation.prepare(events.value), {
        signal,
      });
      if (Exit.isFailure(next)) {
        await finish({ _tag: "Failed", reason: "HostedInferenceFailed" });
        return unavailable();
      }
      return executeRound(next.value, iteration + 1, nextCount);
    }
    const answer = approvedAnswer(generated.value);
    if (Option.isNone(answer)) {
      await finish({ _tag: "Failed", reason: "HostedInferenceFailed" });
      return unavailable();
    }
    return proposeDelivery({
      db,
      userId,
      turnId,
      answer: answer.value,
      deliver,
      finish,
      scheduleRecovery,
    });
  };
  return executeRound(prepared, 1, 0);
};

type HostedToolEvent = Extract<
  Parameters<HostedTextResult["continuation"]["prepare"]>[0][number],
  { readonly _tag: "ToolResult" }
>;

/** Dispatch only installed catalog queries, retaining exact call and outcome for this Pending Turn. */
// @effect-diagnostics-next-line asyncFunction:off
const executeHostedTool = async ({
  db,
  subject,
  userId,
  turnId,
  call,
  iteration,
}: Readonly<{
  db: D1Database;
  subject: TransactionSubject;
  userId: UserId;
  turnId: TranscriptTurnId;
  call: HostedTextResult["toolCalls"][number];
  iteration: number;
}>): Promise<Option.Option<HostedToolEvent>> => {
  const operation = hostedExecutableOperations.find(({ id }) => id === call.operation);
  const evidence = Schema.decodeUnknownOption(CanonicalToolEvidence)(call.params);
  const toolCallId = Schema.decodeOption(ToolCallId)(call.id);
  if (operation === undefined || Option.isNone(evidence) || Option.isNone(toolCallId)) {
    return Option.none();
  }
  const canonicalInput = Schema.decodeOption(operation.input)(evidence.value);
  if (Option.isNone(canonicalInput)) return Option.none();
  const identity = {
    turnId,
    occurredAt: DateTime.formatIso(DateTime.makeUnsafe(transactionNow())),
    iteration,
    toolCallId: toolCallId.value,
    operation: operation.id,
  };
  const recorded = await appendHostedToolEntry(
    db,
    userId,
    Schema.decodeSync(CanonicalToolCallEntry)({
      _tag: "CanonicalToolCallEntry",
      ...identity,
      id: TranscriptEntryId.make(newId()),
      input: evidence.value,
    })
  );
  if (!recorded) return Option.none();
  const response = await executeProtectedCategories({ db, subject });
  const body = await response.json().catch(() => undefined);
  const output = Schema.decodeUnknownOption(CanonicalToolEvidence)(body);
  if (Option.isNone(output)) return Option.none();
  const outcome = response.ok
    ? { _tag: "Succeeded" as const, output: output.value }
    : { _tag: "CanonicalOperationFailed" as const, failure: output.value };
  const result = Schema.decodeSync(CanonicalToolResultEntry)({
    _tag: "CanonicalToolResultEntry",
    ...identity,
    id: TranscriptEntryId.make(newId()),
    outcome,
  });
  return (await appendHostedToolEntry(db, userId, result))
    ? Option.some({
        _tag: "ToolResult",
        toolCallId: result.toolCallId,
        operation: result.operation,
        outcome: result.outcome,
      })
    : Option.none();
};

const approvedAnswer = (result: HostedTextResult): Option.Option<TranscriptText> =>
  result.toolCalls.length === 0 && result.finishReason === "stop"
    ? Schema.decodeUnknownOption(TranscriptText)(result.text)
    : Option.none();

// @effect-diagnostics-next-line asyncFunction:off
const proposeDelivery = async ({
  db,
  userId,
  turnId,
  answer,
  deliver,
  finish,
  scheduleRecovery,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  turnId: TranscriptTurnId;
  answer: TranscriptText;
  deliver: HostedDelivery;
  finish: (outcome: HostedTurnOutcome) => Promise<boolean>;
  scheduleRecovery: (dueAtMs: number) => Promise<void>;
}>): Promise<Response> => {
  const receipt = await stageHostedDelivery({ db, userId, turnId, text: answer });
  await scheduleRecovery(transactionNow() + deliveryAcknowledgmentWindowMs);
  try {
    const response = await deliver({ text: answer, turnId, receipt });
    if (response.ok) return response;
  } catch {
    // The channel rejected the proposed reply. Nothing became visible.
  }
  await finish({ _tag: "Failed", reason: "DeliveryFailed" });
  return unavailable();
};

/** Complete only after the authenticated browser has rendered and acknowledged the staged reply. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const acknowledgeBrowserTurn = async ({
  db,
  subject,
  turnId,
  receipt,
}: Readonly<{
  db: D1Database;
  subject: TransactionSubject;
  turnId: TranscriptTurnId;
  receipt: string;
}>): Promise<Response> => {
  const acknowledged = await acknowledgeHostedDelivery({ db, subject, turnId, receipt });
  return Option.isSome(acknowledged)
    ? Response.json({ status: "completed" }, { status: 200, headers: noStore })
    : unauthenticated();
};

/** Decode a bounded User request; the authenticated channel owns its credential separately. */
export const hostedTurnInput = HostedTurnRequest;
/** Bounded Core-to-DO admission with explicit User identity and ephemeral credential proof. */
export const HostedTurnAdmission = Schema.Struct({
  userId: UserId,
  sessionId: Schema.String.check(Schema.isUUID()),
  digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
  text: TranscriptText,
});
/** The browser sends this receipt only after it has visibly rendered the exact reply. */
export const hostedDeliveryReceipt = HostedTurnReceipt;
/** Receipt forwarded by Core with a fresh WebSession proof, never from public input. */
export const HostedDeliveryAdmission = Schema.Struct({
  userId: UserId,
  sessionId: Schema.String.check(Schema.isUUID()),
  digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
  ...hostedDeliveryReceipt.fields,
});
/** No model or D1 work is bought for invalid input. */
export const invalidHostedTurn = invalid;
