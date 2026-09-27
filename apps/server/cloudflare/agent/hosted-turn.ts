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
  maximumModelRoundMillis,
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
export const completeHostedTurn = ({
  db,
  subject,
  text,
  inference,
  deliver,
  signal,
  scheduleRecovery,
}: HostedTurnInput): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const userId = UserId.make(subject.userId);
      const snapshot = yield* Effect.tryPromise(() =>
        readAdmissibleSnapshot({ db, subject, userId })
      );
      if (snapshot instanceof Response) return snapshot;
      const startedAtMs = transactionNow();
      const selection = selectHostedSession({ snapshot, userId, now: startedAtMs });
      const activeTurnId = TranscriptTurnId.make(newId());
      const prepared = yield* Effect.tryPromise(() =>
        prepareHostedWork({
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
        })
      );
      if (Option.isNone(prepared)) return unavailable();
      const turn = yield* Effect.tryPromise(() =>
        admitHostedTurn({
          db,
          subject,
          selection,
          text,
          now: startedAtMs,
          id: activeTurnId,
        })
      );
      if (Option.isNone(turn)) return unauthenticated();
      yield* Effect.tryPromise(() => scheduleRecovery(startedAtMs + pendingExecutionRecoveryMs));
      return yield* Effect.tryPromise(() =>
        executeAdmittedTurn({
          db,
          userId,
          turnId: turn.value,
          subject,
          startedAtMs,
          prepared: prepared.value,
          deliver,
          signal,
          scheduleRecovery,
        })
      );
    })
  );

const readAdmissibleSnapshot = ({
  db,
  subject,
  userId,
}: Readonly<{
  db: D1Database;
  subject: TransactionSubject;
  userId: UserId;
}>): Promise<HostedTurnSnapshot | Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const current = transactionNow();
      const initial = yield* Effect.tryPromise(() =>
        readHostedSnapshot({ db, subject, now: current })
      );
      if (Option.isNone(initial)) return unauthenticated();
      const recovered = yield* Effect.tryPromise(() =>
        recoverPending({
          db,
          userId,
          pending: initial.value.pending,
          now: current,
        })
      );
      if (recovered === "awaiting") {
        return Response.json({ status: "awaiting_delivery" }, { status: 409, headers: noStore });
      }
      if (recovered === "error") return unavailable();
      const fresh = yield* Effect.tryPromise(() =>
        readHostedSnapshot({ db, subject, now: transactionNow() })
      );
      if (Option.isNone(fresh)) return unauthenticated();
      if (fresh.value.revoked) return consentRequired();
      if (!fresh.value.capacityAvailable) {
        return Response.json({ status: "capacity_exceeded" }, { status: 429, headers: noStore });
      }
      return fresh.value;
    })
  );

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
const prepareHostedWork = ({
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
}: WorkPreflight): Promise<Option.Option<PreparedHostedText>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const initial = yield* Effect.tryPromise(() =>
        readHostedContinuity({
          db,
          subject,
          sessionId: selection.id,
          now: startedAtMs,
        })
      );
      const continuity = yield* Effect.tryPromise(() =>
        compactHostedContinuity({
          db,
          subject,
          sessionId: selection.id,
          now: startedAtMs,
          inference,
          initial,
          signal,
        })
      );
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
      const prepared = yield* Effect.tryPromise(() =>
        Effect.runPromiseExit(
          inference.prepareText({
            context,
            toolChoice: "auto",
            maximumToolCalls: HostedToolCallMaximum.make(maximumToolCallsPerTurn),
            availableOperations: hostedExecutableOperations.map(({ id }) => id),
          }),
          { signal }
        )
      );
      return Exit.isFailure(prepared) || signal.aborted
        ? Option.none()
        : Option.some(prepared.value);
    })
  );

type HostedContinuity = Awaited<ReturnType<typeof readHostedContinuity>>;

/** Best-effort replacement: failure cannot delete evidence or invalidate existing continuity. */
// No new telemetry: this optional preflight shares the Turn's bounded provider work; existing
// provider telemetry observes its execution. Failures are contained without reporting User content.
const compactHostedContinuity = ({
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
}>): Promise<HostedContinuity> =>
  Effect.runPromise(
    Effect.gen(function* () {
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
            yield* Effect.tryPromise(() =>
              Effect.runPromiseExit(
                inference.countTranscript(initial.transcript.map(({ entry }) => entry)),
                { signal }
              )
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
      if (!(yield* Effect.tryPromise(() => reserveHostedCompaction({ db, subject, sessionId })))) {
        return initial;
      }
      const prepared = yield* Effect.tryPromise(() =>
        Effect.runPromiseExit(
          inference.prepareStructured({
            purpose: "conversation-compaction",
            context: {
              prior: Option.map(initial.compactedConversation, ({ text }) => text),
              entries: prefix.map(({ entry }) => entry),
            },
            outputSchema: CompactedConversationOutput,
          }),
          { signal }
        )
      );
      if (Exit.isFailure(prepared) || wasAborted()) {
        return initial;
      }
      const generated = yield* Effect.tryPromise(() =>
        Effect.runPromiseExit(prepared.value.execute, { signal })
      );
      if (Exit.isFailure(generated) || wasAborted()) {
        return initial;
      }
      const tokens = yield* Effect.tryPromise(() =>
        Effect.runPromiseExit(inference.countText(generated.value.compactedConversation), {
          signal,
        })
      );
      if (Exit.isFailure(tokens) || tokens.value > defaultCompactionMaximumTokens || wasAborted()) {
        return initial;
      }
      const last = prefix.at(-1);
      if (last === undefined) {
        return initial;
      }
      const saved = yield* Effect.tryPromise(() =>
        commitHostedCompaction({
          db,
          subject,
          sessionId,
          continuity: initial,
          throughSequence: Number(last.sequence),
          text: generated.value.compactedConversation,
          signal,
        })
      );
      return saved
        ? yield* Effect.tryPromise(() => readHostedContinuity({ db, subject, sessionId, now }))
        : initial;
    })
  );

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
}>): Promise<"clear" | "awaiting" | "error"> =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (Option.isNone(pending)) return "clear" as const;
      if (
        pending.value.proposed_at_ms !== null &&
        now - pending.value.proposed_at_ms < deliveryAcknowledgmentWindowMs
      ) {
        return "awaiting" as const;
      }
      const recovered = yield* Effect.tryPromise(() =>
        recoverHostedTurn({ db, userId, turn: pending.value, now })
      );
      return recovered ? ("clear" as const) : ("error" as const);
    })
  );

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
const executeAdmittedTurn = ({
  db,
  userId,
  turnId,
  subject,
  startedAtMs,
  prepared,
  deliver,
  signal,
  scheduleRecovery,
}: AdmittedWork): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const finish = (result: HostedTurnOutcome): Promise<boolean> =>
        finishHostedTurn({
          db,
          userId,
          turnId,
          startedAtMs,
          result,
          subject,
          now: transactionNow(),
        });
      const seenCalls = new Set<string>();
      // Each continuation is one-shot; the next round starts only after every result is retained.
      const executeRound = (
        active: PreparedHostedText,
        iteration: number,
        usedCalls: number
      ): Effect.Effect<Response, Cause.UnknownError> =>
        Effect.gen(function* () {
          if (iteration > maximumHostedTurnIterations) {
            yield* Effect.tryPromise(() =>
              finish({ _tag: "Failed", reason: "HostedInferenceFailed" })
            );
            return unavailable();
          }
          const remainingMs = startedAtMs + maximumModelRoundMillis - transactionNow();
          if (remainingMs <= 0) {
            yield* Effect.tryPromise(() =>
              finish({ _tag: "Failed", reason: "HostedInferenceTimedOut" })
            );
            return unavailable();
          }
          const generated = yield* Effect.tryPromise(() =>
            Effect.runPromiseExit(active.execute.pipe(Effect.timeout(`${remainingMs} millis`)), {
              signal,
            })
          );
          if (
            signal.aborted ||
            (Exit.isFailure(generated) && Cause.hasInterrupts(generated.cause))
          ) {
            return (yield* Effect.tryPromise(() => finish({ _tag: "Interrupted" })))
              ? interrupted()
              : unavailable();
          }
          if (Exit.isFailure(generated)) {
            const timedOut = Option.exists(
              Cause.findErrorOption(generated.cause),
              Cause.isTimeoutError
            );
            yield* Effect.tryPromise(() =>
              finish({
                _tag: "Failed",
                reason: timedOut ? "HostedInferenceTimedOut" : "HostedInferenceFailed",
              })
            );
            return unavailable();
          }
          if (generated.value.toolCalls.length > 0) {
            const nextCount = usedCalls + generated.value.toolCalls.length;
            const ids = generated.value.toolCalls.map(({ id }) => id);
            const duplicate =
              ids.some((id) => seenCalls.has(id)) || new Set(ids).size !== ids.length;
            if (
              nextCount > maximumToolCallsPerTurn ||
              generated.value.finishReason !== "tool-calls" ||
              duplicate
            ) {
              yield* Effect.tryPromise(() =>
                finish({ _tag: "Failed", reason: "HostedInferenceFailed" })
              );
              return unavailable();
            }
            const events: Array<HostedToolEvent> = [];
            let recorded = true;
            for (const call of generated.value.toolCalls) {
              seenCalls.add(call.id);
              const result = yield* Effect.tryPromise(() =>
                executeHostedTool({ db, subject, userId, turnId, call, iteration })
              );
              if (Option.isNone(result)) {
                recorded = false;
                break;
              }
              events.push(result.value);
            }
            if (!recorded) {
              yield* Effect.tryPromise(() =>
                finish({ _tag: "Failed", reason: "HostedInferenceFailed" })
              );
              return unavailable();
            }
            const next = yield* Effect.tryPromise(() =>
              Effect.runPromiseExit(generated.value.continuation.prepare(events), {
                signal,
              })
            );
            if (Exit.isFailure(next) && Cause.hasInterrupts(next.cause)) {
              return (yield* Effect.tryPromise(() => finish({ _tag: "Interrupted" })))
                ? interrupted()
                : unavailable();
            }
            if (Exit.isFailure(next)) {
              yield* Effect.tryPromise(() =>
                finish({ _tag: "Failed", reason: "HostedInferenceFailed" })
              );
              return unavailable();
            }
            return yield* executeRound(next.value, iteration + 1, nextCount);
          }
          const answer = approvedAnswer(generated.value);
          if (Option.isNone(answer)) {
            yield* Effect.tryPromise(() =>
              finish({ _tag: "Failed", reason: "HostedInferenceFailed" })
            );
            return unavailable();
          }
          return yield* Effect.tryPromise(() =>
            proposeDelivery({
              db,
              userId,
              turnId,
              answer: answer.value,
              deliver,
              finish,
              scheduleRecovery,
            })
          );
        });
      const outcome = yield* Effect.exit(executeRound(prepared, 1, 0));
      if (Exit.isSuccess(outcome)) return outcome.value;
      // A platform defect may still have committed a canonical query. Never publish a reply or
      // claim a successful Turn without its evidence; the durable alarm is the fallback if D1 fails.
      const result = signal.aborted
        ? yield* Effect.tryPromise(() => finish({ _tag: "Interrupted" }).catch(() => false))
        : yield* Effect.tryPromise(() =>
            finish({ _tag: "Failed", reason: "HostedInferenceFailed" }).catch(() => false)
          );
      return result && signal.aborted ? interrupted() : unavailable();
    })
  );

type HostedToolEvent = Extract<
  Parameters<HostedTextResult["continuation"]["prepare"]>[0][number],
  { readonly _tag: "ToolResult" }
>;

/** Dispatch only installed catalog queries, retaining exact call and outcome for this Pending Turn. */
const executeHostedTool = ({
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
}>): Promise<Option.Option<HostedToolEvent>> =>
  Effect.runPromise(
    Effect.gen(function* () {
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
      const callEntry = yield* Schema.decodeEffect(CanonicalToolCallEntry)({
        _tag: "CanonicalToolCallEntry",
        ...identity,
        id: TranscriptEntryId.make(newId()),
        input: evidence.value,
      });
      const recorded = yield* Effect.tryPromise(() =>
        appendHostedToolEntry({ db, userId, entry: callEntry })
      );
      if (!recorded) return Option.none();
      const response = yield* Effect.tryPromise(() => executeProtectedCategories({ db, subject }));
      const body = yield* Effect.tryPromise(() => response.json().catch(() => undefined));
      const output = Schema.decodeUnknownOption(CanonicalToolEvidence)(body);
      if (Option.isNone(output)) return Option.none();
      const outcome = response.ok
        ? { _tag: "Succeeded" as const, output: output.value }
        : { _tag: "CanonicalOperationFailed" as const, failure: output.value };
      const result = yield* Schema.decodeEffect(CanonicalToolResultEntry)({
        _tag: "CanonicalToolResultEntry",
        ...identity,
        id: TranscriptEntryId.make(newId()),
        outcome,
      });
      return (yield* Effect.tryPromise(() => appendHostedToolEntry({ db, userId, entry: result })))
        ? Option.some({
            _tag: "ToolResult",
            toolCallId: result.toolCallId,
            operation: result.operation,
            outcome: result.outcome,
          })
        : Option.none();
    })
  );

const approvedAnswer = (result: HostedTextResult): Option.Option<TranscriptText> =>
  result.toolCalls.length === 0 && result.finishReason === "stop"
    ? Schema.decodeUnknownOption(TranscriptText)(result.text)
    : Option.none();

const proposeDelivery = ({
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
}>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const receipt = yield* Effect.tryPromise(() =>
        stageHostedDelivery({ db, userId, turnId, text: answer })
      );
      yield* Effect.tryPromise(() =>
        scheduleRecovery(transactionNow() + deliveryAcknowledgmentWindowMs)
      );
      const delivered = yield* Effect.exit(
        Effect.tryPromise(() => deliver({ text: answer, turnId, receipt }))
      );
      if (Exit.isSuccess(delivered) && delivered.value.ok) return delivered.value;
      // The channel rejected the proposed reply. Nothing became visible.
      yield* Effect.tryPromise(() => finish({ _tag: "Failed", reason: "DeliveryFailed" }));
      return unavailable();
    })
  );

/** Complete only after the authenticated browser has rendered and acknowledged the staged reply. */
export const acknowledgeBrowserTurn = ({
  db,
  subject,
  turnId,
  receipt,
}: Readonly<{
  db: D1Database;
  subject: TransactionSubject;
  turnId: TranscriptTurnId;
  receipt: string;
}>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const acknowledged = yield* Effect.tryPromise(() =>
        acknowledgeHostedDelivery({ db, subject, turnId, receipt })
      );
      return Option.isSome(acknowledged)
        ? Response.json({ status: "completed" }, { status: 200, headers: noStore })
        : unauthenticated();
    })
  );

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
