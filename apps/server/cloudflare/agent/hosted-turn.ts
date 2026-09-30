import {
  CanonicalToolCallEntry,
  CanonicalToolEvidence,
  type CanonicalToolOutcome,
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
import {
  HostedInferenceError,
  type HostedInferenceService,
  type HostedTextResult,
  HostedToolCallMaximum,
  type PreparedHostedText,
} from "@fidy/server/hosted-inference";
import { Cause, DateTime, Duration, Effect, Exit, Option, Schema } from "effect";
import { atomicBatchOperation, operationCatalog } from "@fidy/server/canonical-runtime";
import { decideOperationAccess } from "../../src/shell/_shared/operation-policy";
import {
  maximumHostedTurnIterations,
  maximumModelRoundMillis,
  maximumToolCallsPerTurn,
} from "../../src/shell/_shared/hosted-turn-bounds";
import { executeHostedQuery, isInstalledHostedQuery } from "./hosted-canonical-query";
import {
  consumeHostedConfirmation,
  findHostedConfirmation,
  isHostedConfirmationAttempt,
  issueHostedConfirmation,
} from "./hosted-confirmation";
import type { ConfirmationRow } from "./hosted-confirmation";
import { canonicalMutationAdapter } from "../mutations/canonical-mutation-registry";
import type { HostedCommitFence } from "../mutations/canonical-mutation-unit";
import {
  HostedTurnProgressRequest,
  HostedTurnReceipt,
  HostedTurnRequest,
} from "../../src/shell/agent/hosted-turn-api";
import type { TransactionSubject } from "../transactions/transaction-boundary";
import {
  type HostedSubject,
  type WhatsAppHostedSubject,
  type WhatsAppInboundEvidence,
  isWhatsAppHosted,
} from "./hosted-authority";
import {
  recordWhatsAppSend,
  rejectUnstartedWhatsAppDelivery,
  stageWhatsAppDelivery,
  startWhatsAppSend,
} from "./whatsapp-delivery";
import { isWhatsAppWindowOpen, readWhatsAppPendingWork } from "./whatsapp-turn";
import type {
  HostedDeliveryCorrelationToken,
  WhatsAppProviderMessageId,
} from "../../src/shell/channels/whatsapp/model";
import { transactionNow } from "../transactions/transaction-boundary";
import { newId } from "../platform/operations";
import {
  type HostedAdmissionChannel,
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
  refreshHostedDelivery,
  reserveHostedCompaction,
  selectHostedSession,
  stageHostedDelivery,
} from "./turn-store";

// Only installed owners whose caller policy permits this authority enter the toolkit.
const hostedExecutableOperations = operationCatalog.operations.filter(
  ({ id, policy }) =>
    ((policy.kind === "query" && isInstalledHostedQuery(id)) ||
      (policy.kind === "mutation" &&
        (id === atomicBatchOperation || Option.isSome(canonicalMutationAdapter(id))))) &&
    decideOperationAccess(policy.access, {
      _tag: "HostedAgentSession",
      authorityRoot: "no-verified-whatsapp-authority",
    })._tag === "Allowed"
);

const requiresHostedConfirmation = ({
  operation,
}: HostedTextResult["toolCalls"][number]): boolean =>
  hostedExecutableOperations.find(({ id }) => id === operation)?.policy.agentConfirmation ===
  "required";

const hostedAuthority = {
  _tag: "HostedAgentSession",
  authorityRoot: "no-verified-whatsapp-authority",
} as const;
const hostedBatchChildren = Schema.Struct({
  payload: Schema.Struct({
    calls: Schema.NonEmptyArray(Schema.Struct({ operation: Schema.String })),
  }),
});
/** A batch cannot use its WebSession executor to smuggle a child denied to Hosted Agent Sessions. */
const hostedBatchAllowed = (input: CanonicalToolEvidence): boolean => {
  const parsed = Schema.decodeUnknownOption(hostedBatchChildren)(input);
  return (
    Option.isSome(parsed) &&
    parsed.value.payload.calls.every(({ operation: id }) => {
      const child = operationCatalog.byId.get(id);
      return (
        child !== undefined &&
        child.atomicBatchEligible &&
        decideOperationAccess(child.policy.access, hostedAuthority)._tag === "Allowed"
      );
    })
  );
};

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
const resourceRefused = (): Response =>
  Response.json({ status: "capacity_exceeded" }, { status: 429, headers: noStore });

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

type WhatsAppHostedDelivery = Readonly<{
  _tag: "WhatsApp";
  send: (
    input: Readonly<{
      text: TranscriptText;
      turnId: TranscriptTurnId;
      correlationToken: HostedDeliveryCorrelationToken;
    }>
  ) => Promise<
    | Readonly<{ kind: "accepted"; messageId: WhatsAppProviderMessageId }>
    | Readonly<{ kind: "ambiguous" | "rejected" }>
  >;
}>;
type ChannelDelivery =
  | Readonly<{ _tag: "Browser"; propose: HostedDelivery }>
  | WhatsAppHostedDelivery;

type HostedMutationExecutor = (
  operation: (typeof operationCatalog.operations)[number]["id"],
  input: CanonicalToolEvidence,
  hostedFence: HostedCommitFence
) => Promise<Response>;

type HostedTurnInput = Readonly<{
  db: D1Database;
  subject: TransactionSubject;
  bucket: Option.Option<R2Bucket>;
  executeMutation: Option.Option<HostedMutationExecutor>;
  text: TranscriptText;
  inference: HostedInferenceService;
  deliver: HostedDelivery;
  signal: AbortSignal;
  scheduleRecovery: (dueAtMs: number) => Promise<void>;
}>;
type AdmittedTurnInput = Omit<HostedTurnInput, "subject" | "deliver"> &
  Readonly<{ onAdmitted: Option.Option<(turnId: TranscriptTurnId) => void> }> &
  (
    | Readonly<{
        subject: TransactionSubject;
        deliver: HostedDelivery;
      }>
    | Readonly<{
        subject: WhatsAppHostedSubject;
        deliver: WhatsAppHostedDelivery;
        inbound: WhatsAppInboundEvidence;
      }>
  );

export const completeHostedTurn = (input: HostedTurnInput): Promise<Response> =>
  executeHostedTurn({ ...input, onAdmitted: Option.none() });
export const completeHostedTurnWithAdmission = ({
  input,
  onAdmitted,
}: Readonly<{
  input: HostedTurnInput;
  onAdmitted: (turnId: TranscriptTurnId) => void;
}>): Promise<Response> => executeHostedTurn({ ...input, onAdmitted: Option.some(onAdmitted) });

/** Verified inbound text shares the hosted lifecycle but never borrows a browser credential. */
export const completeWhatsAppTurnWithAdmission = ({
  input,
  onAdmitted,
}: Readonly<{
  input: Omit<HostedTurnInput, "subject" | "deliver"> &
    Readonly<{
      subject: WhatsAppHostedSubject;
      inbound: WhatsAppInboundEvidence;
      deliver: WhatsAppHostedDelivery;
    }>;
  onAdmitted: (turnId: TranscriptTurnId) => void;
}>): Promise<Response> =>
  executeHostedTurn({
    ...input,
    onAdmitted: Option.some(onAdmitted),
  });

/** Continue only an admitted, still-pending User Turn; Queue contains no User content. */
export const resumeWhatsAppTurn = ({
  db,
  userId,
  turnId,
  inference,
  deliver,
  signal,
  scheduleRecovery,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  turnId: TranscriptTurnId;
  inference: HostedInferenceService;
  deliver: (
    recipient: Readonly<{
      bsuid: WhatsAppHostedSubject["bsuid"];
      businessPhoneNumberId: WhatsAppInboundEvidence["businessPhoneNumberId"];
    }>
  ) => WhatsAppHostedDelivery;
  signal: AbortSignal;
  scheduleRecovery: (dueAtMs: number) => Promise<void>;
}>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const work = yield* readWhatsAppPendingWork({ db, userId, turnId });
      if (Option.isNone(work)) return new Response(null, { status: 200 });
      const {
        started_at_ms,
        hosted_session_id,
        portfolio_id,
        bsuid,
        business_phone_number_id,
        text,
      } = work.value;
      const subject: WhatsAppHostedSubject = {
        _tag: "WhatsAppHosted",
        userId,
        portfolioId: portfolio_id,
        bsuid,
      };
      const now = transactionNow();
      const snapshot = yield* readHostedSnapshot({ db, subject, now });
      if (Option.isNone(snapshot) || work.value.association_current !== 1) {
        yield* finishHostedTurn({
          db,
          userId,
          turnId,
          startedAtMs: started_at_ms,
          result: { _tag: "Interrupted" },
          subject,
          now,
        });
        return interrupted();
      }
      const prepared = yield* Effect.tryPromise(() =>
        prepareHostedWork({
          db,
          subject,
          selection: { id: hosted_session_id },
          snapshot: snapshot.value,
          userId,
          activeTurnId: turnId,
          startedAtMs: started_at_ms,
          text,
          inference,
          signal,
          executeMutation: Option.none(),
          admittedWhatsAppTurn: Option.some(turnId),
        })
      );
      if (Option.isNone(prepared)) {
        if (!signal.aborted) {
          yield* finishHostedTurn({
            db,
            userId,
            turnId,
            startedAtMs: started_at_ms,
            result: { _tag: "Failed", reason: "HostedInferenceFailed" },
            subject,
            now: transactionNow(),
          });
        }
        return unavailable();
      }
      return yield* Effect.tryPromise(() =>
        executeAdmittedTurn({
          db,
          userId,
          turnId,
          subject,
          bucket: Option.none(),
          executeMutation: Option.none(),
          startedAtMs: started_at_ms,
          prepared: prepared.value,
          deliver: deliver({ bsuid, businessPhoneNumberId: business_phone_number_id }),
          signal,
          scheduleRecovery,
        })
      );
    })
  );

/**
 * Own one hosted Turn under the per-User Durable Object's serialized request. D1 owns
 * admission and exact evidence; the adapter owns bounded provider rounds and delivery. A lost
 * request after Pending is recovered by the next Turn, never silently reported Completed.
 */
const executeHostedTurn = (input: AdmittedTurnInput): Promise<Response> => {
  const channel: HostedAdmissionChannel =
    "inbound" in input
      ? { _tag: "WhatsApp", subject: input.subject, inbound: input.inbound }
      : { _tag: "Browser", subject: input.subject };
  const {
    db,
    subject,
    bucket,
    executeMutation,
    text,
    inference,
    signal,
    scheduleRecovery,
    onAdmitted,
  } = input;
  return Effect.runPromise(
    Effect.gen(function* () {
      const isAborted = (): boolean => signal.aborted;
      if (isAborted()) return unavailable();
      const userId = UserId.make(subject.userId);
      const snapshot = yield* Effect.tryPromise(() =>
        readAdmissibleSnapshot({ db, subject, userId })
      );
      if (snapshot instanceof Response) return snapshot;
      const startedAtMs = transactionNow();
      const selection = selectHostedSession({ snapshot, userId, now: startedAtMs });
      const activeTurnId = TranscriptTurnId.make(newId());
      if (
        !isWhatsAppHosted(subject) &&
        !("inbound" in input) &&
        isHostedConfirmationAttempt(text)
      ) {
        const challenge = yield* findHostedConfirmation({
          db,
          userId,
          command: text,
          now: startedAtMs,
        });
        if (Option.isNone(challenge) || Option.isNone(executeMutation)) return unauthenticated();
        const turn = yield* admitHostedTurn({
          db,
          channel,
          selection,
          text,
          now: startedAtMs,
          id: activeTurnId,
        });
        if (Option.isNone(turn)) return unauthenticated();
        if (isAborted()) {
          yield* recoverHostedTurn({
            db,
            userId,
            turn: {
              id: turn.value,
              started_at_ms: startedAtMs,
              proposed_at_ms: null,
            },
            now: transactionNow(),
          });
          return unavailable();
        }
        yield* Effect.tryPromise(() => scheduleRecovery(startedAtMs + pendingExecutionRecoveryMs));
        if (Option.isSome(onAdmitted)) {
          onAdmitted.value(turn.value);
        }
        return yield* Effect.tryPromise(() =>
          executeConfirmedHostedTurn({
            db,
            subject,
            userId,
            turnId: turn.value,
            startedAtMs,
            challenge: challenge.value,
            executeMutation: executeMutation.value,
            signal,
            deliver: input.deliver,
            scheduleRecovery,
          })
        );
      }
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
          executeMutation,
          admittedWhatsAppTurn: Option.none(),
        })
      );
      if (Option.isNone(prepared) || isAborted()) return unavailable();
      const turn = yield* admitHostedTurn({
        db,
        channel,
        selection,
        text,
        now: startedAtMs,
        id: activeTurnId,
      });
      if (Option.isNone(turn)) return unauthenticated();
      if (isAborted()) {
        yield* recoverHostedTurn({
          db,
          userId,
          turn: {
            id: turn.value,
            started_at_ms: startedAtMs,
            proposed_at_ms: null,
          },
          now: transactionNow(),
        });
        return unavailable();
      }
      yield* Effect.tryPromise(() => scheduleRecovery(startedAtMs + pendingExecutionRecoveryMs));
      if (Option.isSome(onAdmitted)) {
        onAdmitted.value(turn.value);
      }
      return yield* Effect.tryPromise(() =>
        executeAdmittedTurn({
          db,
          userId,
          turnId: turn.value,
          subject,
          bucket,
          executeMutation,
          startedAtMs,
          prepared: prepared.value,
          deliver: "inbound" in input ? input.deliver : { _tag: "Browser", propose: input.deliver },
          signal,
          scheduleRecovery,
        })
      );
    })
  );
};

const readAdmissibleSnapshot = ({
  db,
  subject,
  userId,
}: Readonly<{
  db: D1Database;
  subject: HostedSubject;
  userId: UserId;
}>): Promise<HostedTurnSnapshot | Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const current = transactionNow();
      const initial = yield* readHostedSnapshot({ db, subject, now: current });
      if (Option.isNone(initial)) return unauthenticated();
      const recovered = yield* recoverPending({
        db,
        userId,
        pending: initial.value.pending,
        now: current,
      });
      if (recovered === "awaiting") {
        return Response.json({ status: "awaiting_delivery" }, { status: 409, headers: noStore });
      }
      if (recovered === "error") return unavailable();
      const fresh = yield* readHostedSnapshot({ db, subject, now: transactionNow() });
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
  subject: HostedSubject;
  selection: Pick<ReturnType<typeof selectHostedSession>, "id">;
  snapshot: HostedTurnSnapshot;
  userId: UserId;
  activeTurnId: TranscriptTurnId;
  startedAtMs: number;
  text: TranscriptText;
  inference: HostedInferenceService;
  signal: AbortSignal;
  executeMutation: HostedTurnInput["executeMutation"];
  admittedWhatsAppTurn: Option.Option<TranscriptTurnId>;
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
  executeMutation,
  admittedWhatsAppTurn,
}: WorkPreflight): Promise<Option.Option<PreparedHostedText>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const initial = yield* readHostedContinuity({
        db,
        subject,
        sessionId: selection.id,
        now: startedAtMs,
        admittedWhatsAppTurn,
      });
      const continuity = snapshot.revoked
        ? initial
        : yield* Effect.tryPromise(() =>
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
        transcript: continuity.transcript.filter(({ entry }) => entry.turnId !== activeTurnId),
        activeRequest: text,
      });
      const prepared = yield* Effect.tryPromise(() =>
        Effect.runPromiseExit(
          inference.prepareText({
            context,
            toolChoice: "auto",
            maximumToolCalls: HostedToolCallMaximum.make(maximumToolCallsPerTurn),
            availableOperations: isWhatsAppHosted(subject)
              ? []
              : hostedExecutableOperations
                  .filter(({ policy }) => policy.kind === "query" || Option.isSome(executeMutation))
                  .map(({ id }) => id),
          }),
          { signal }
        )
      );
      return Exit.isFailure(prepared) || signal.aborted
        ? Option.none()
        : Option.some(prepared.value);
    })
  );

type HostedContinuity = Effect.Success<ReturnType<typeof readHostedContinuity>>;

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
  subject: HostedSubject;
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
      if (!(yield* reserveHostedCompaction({ db, subject, sessionId }))) {
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
      const saved = yield* commitHostedCompaction({
        db,
        subject,
        sessionId,
        continuity: initial,
        throughSequence: Number(last.sequence),
        text: generated.value.compactedConversation,
        signal,
      });
      return saved
        ? yield* readHostedContinuity({
            db,
            subject,
            sessionId,
            now,
            admittedWhatsAppTurn: Option.none(),
          })
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
}>): Effect.Effect<"clear" | "awaiting" | "error", Cause.UnknownError | Schema.SchemaError> => {
  if (Option.isNone(pending)) return Effect.succeed("clear");
  if (
    pending.value.proposed_at_ms !== null &&
    now - pending.value.proposed_at_ms < deliveryAcknowledgmentWindowMs
  ) {
    return Effect.succeed("awaiting");
  }
  return recoverHostedTurn({ db, userId, turn: pending.value, now }).pipe(
    Effect.map((recovered) => (recovered ? ("clear" as const) : ("error" as const)))
  );
};

type AdmittedWork = Readonly<{
  db: D1Database;
  userId: UserId;
  subject: HostedSubject;
  bucket: Option.Option<R2Bucket>;
  executeMutation: HostedTurnInput["executeMutation"];
  turnId: TranscriptTurnId;
  startedAtMs: number;
  prepared: PreparedHostedText;
  deliver: ChannelDelivery;
  signal: AbortSignal;
  scheduleRecovery: (dueAtMs: number) => Promise<void>;
}>;

/** The only path allowed to terminalize a Pending Turn. */
const executeAdmittedTurn = ({
  db,
  userId,
  turnId,
  subject,
  bucket,
  executeMutation,
  startedAtMs,
  prepared,
  deliver,
  signal,
  scheduleRecovery,
}: AdmittedWork): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const finish = (result: HostedTurnOutcome): ReturnType<typeof finishHostedTurn> =>
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
      const mutation = { started: false };
      // Each continuation is one-shot; the next round starts only after every result is retained.
      const executeRound = (
        active: PreparedHostedText,
        iteration: number,
        usedCalls: number
      ): Effect.Effect<Response, Cause.UnknownError | Schema.SchemaError> =>
        Effect.gen(function* () {
          if (iteration > maximumHostedTurnIterations) {
            yield* finish({ _tag: "Failed", reason: "HostedInferenceFailed" });
            return unavailable();
          }
          const remainingMs = startedAtMs + maximumModelRoundMillis - transactionNow();
          if (remainingMs <= 0) {
            yield* finish({ _tag: "Failed", reason: "HostedInferenceTimedOut" });
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
            return (yield* finish({ _tag: "Interrupted" })) ? interrupted() : unavailable();
          }
          if (Exit.isFailure(generated)) {
            const error = Cause.findErrorOption(generated.cause);
            const timedOut = Option.exists(error, Cause.isTimeoutError);
            const refused = Option.exists(
              error,
              (failure) =>
                failure instanceof HostedInferenceError && failure.reason._tag === "ResourceLimit"
            );
            yield* finish({
              _tag: "Failed",
              reason: timedOut ? "HostedInferenceTimedOut" : "HostedInferenceFailed",
            });
            return refused ? resourceRefused() : unavailable();
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
              yield* finish({ _tag: "Failed", reason: "HostedInferenceFailed" });
              return unavailable();
            }
            if (
              generated.value.toolCalls.length > 1 &&
              generated.value.toolCalls.some(requiresHostedConfirmation)
            ) {
              yield* finish({ _tag: "Failed", reason: "HostedInferenceFailed" });
              return unavailable();
            }
            const mutationCommit = { done: false };
            let executed: Option.Option<ReadonlyArray<HostedToolAction>> = Option.some([]);
            for (const call of generated.value.toolCalls) {
              if (
                Option.isNone(executed) ||
                transactionNow() >= startedAtMs + maximumModelRoundMillis
              ) {
                executed = Option.none();
                break;
              }
              seenCalls.add(call.id);
              const prior = executed.value;
              const action = yield* Effect.tryPromise(() =>
                executeHostedTool({
                  db,
                  subject,
                  bucket,
                  executeMutation,
                  userId,
                  turnId,
                  call,
                  iteration,
                  signal,
                  mutation,
                  deadlineMs: startedAtMs + maximumModelRoundMillis,
                })
              );
              if (
                Option.exists(action, (value) => value._tag === "Result" && value.mutationSucceeded)
              ) {
                mutationCommit.done = true;
              }
              executed = Option.map(action, (value) => [...prior, value]);
            }
            if (Option.isNone(executed)) {
              if (mutationCommit.done) {
                return yield* Effect.tryPromise(() =>
                  proposeDelivery({
                    db,
                    userId,
                    turnId,
                    answer: committedAnswer(Option.none()),
                    deliver,
                    finish,
                    scheduleRecovery,
                  })
                );
              }
              yield* finish({
                _tag: "Failed",
                reason:
                  transactionNow() >= startedAtMs + maximumModelRoundMillis
                    ? "HostedInferenceTimedOut"
                    : "HostedInferenceFailed",
              });
              return unavailable();
            }
            const actions = executed.value;
            if (mutationCommit.done) {
              return yield* Effect.tryPromise(() =>
                proposeDelivery({
                  db,
                  userId,
                  turnId,
                  answer: committedAnswer(Option.some(actions)),
                  deliver,
                  finish,
                  scheduleRecovery,
                })
              );
            }
            if (transactionNow() >= startedAtMs + maximumModelRoundMillis) {
              yield* finish({ _tag: "Failed", reason: "HostedInferenceTimedOut" });
              return unavailable();
            }
            const challenge = actions.find((action) => action._tag === "Challenge");
            if (challenge !== undefined) {
              return yield* Effect.tryPromise(() =>
                proposeDelivery({
                  db,
                  userId,
                  turnId,
                  answer: challenge.text,
                  deliver,
                  finish,
                  scheduleRecovery,
                })
              );
            }
            const events = actions
              .filter((action) => action._tag === "Result")
              .map((action) => action.event);
            const remainingPreparationMs = startedAtMs + maximumModelRoundMillis - transactionNow();
            if (remainingPreparationMs <= 0) {
              yield* finish({ _tag: "Failed", reason: "HostedInferenceTimedOut" });
              return unavailable();
            }
            const next = yield* Effect.tryPromise(() =>
              Effect.runPromiseExit(
                generated.value.continuation
                  .prepare(events)
                  .pipe(Effect.timeout(`${remainingPreparationMs} millis`)),
                { signal }
              )
            );
            if (Exit.isFailure(next) && Cause.hasInterrupts(next.cause)) {
              return (yield* finish({ _tag: "Interrupted" })) ? interrupted() : unavailable();
            }
            if (Exit.isFailure(next)) {
              const timedOut = Option.exists(
                Cause.findErrorOption(next.cause),
                Cause.isTimeoutError
              );
              yield* finish({
                _tag: "Failed",
                reason: timedOut ? "HostedInferenceTimedOut" : "HostedInferenceFailed",
              });
              return unavailable();
            }
            return yield* executeRound(next.value, iteration + 1, nextCount);
          }
          const answer = approvedAnswer(generated.value);
          if (Option.isNone(answer)) {
            yield* finish({ _tag: "Failed", reason: "HostedInferenceFailed" });
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
      // A platform defect may still have committed a canonical query. Never publish a reply or
      // claim a successful Turn without its evidence; the durable alarm is the fallback if D1 fails.
      return yield* executeRound(prepared, 1, 0).pipe(
        Effect.catchCause(() =>
          Effect.gen(function* () {
            if (mutation.started) return unavailable();
            const result = yield* Effect.exit(
              finish(
                signal.aborted
                  ? { _tag: "Interrupted" }
                  : { _tag: "Failed", reason: "HostedInferenceFailed" }
              )
            );
            return Exit.isSuccess(result) && result.value && signal.aborted
              ? interrupted()
              : unavailable();
          })
        )
      );
    })
  );

type HostedToolEvent = Extract<
  Parameters<HostedTextResult["continuation"]["prepare"]>[0][number],
  { readonly _tag: "ToolResult" }
>;
/** Decode the owner's response into bounded evidence without elevating it to caller authority. */
const hostedResponseOutcome = (response: Response): Promise<CanonicalToolOutcome> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const body = yield* Effect.tryPromise(() => response.json().catch(() => undefined));
      const output = Schema.decodeUnknownOption(CanonicalToolEvidence)(body);
      if (Option.isNone(output)) {
        return { _tag: "ToolOutputRejected", failure: { code: "canonical_result_unavailable" } };
      }
      if (!response.ok) return { _tag: "CanonicalOperationFailed", failure: output.value };
      return { _tag: "Succeeded", output: output.value };
    })
  );

type HostedToolAction =
  | Readonly<{ _tag: "Result"; event: HostedToolEvent; mutationSucceeded: boolean }>
  | Readonly<{ _tag: "Challenge"; text: TranscriptText }>;
/** A completed canonical write never licenses an unqualified success for other failed calls. */
const committedAnswer = (
  actions: Option.Option<ReadonlyArray<HostedToolAction>>
): TranscriptText => {
  if (Option.isNone(actions)) {
    return TranscriptText.make(
      "Una operación se completó; el estado de las demás no está confirmado."
    );
  }
  const partial = actions.value.some(
    (action) =>
      action._tag === "Result" &&
      action.event.outcome._tag !== "Succeeded" &&
      action.event.outcome._tag !== "CommittedOutputUnavailable"
  );
  return TranscriptText.make(
    partial ? "Una operación se completó; otras no pudieron completarse." : "Operación completada."
  );
};

type ToolIdentity = Readonly<{
  turnId: TranscriptTurnId;
  occurredAt: string;
  iteration: number;
  toolCallId: ToolCallId;
  operation: (typeof operationCatalog.operations)[number]["id"];
}>;

/** Persist one canonical call under the Pending Turn before executing its owner. */
const recordHostedToolCall = ({
  db,
  userId,
  identity,
  input,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  identity: ToolIdentity;
  input: CanonicalToolEvidence;
}>): Promise<boolean> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const entry = yield* Schema.decodeEffect(CanonicalToolCallEntry)({
        _tag: "CanonicalToolCallEntry",
        ...identity,
        id: TranscriptEntryId.make(newId()),
        input,
      });
      return yield* appendHostedToolEntry({ db, userId, entry });
    })
  );

/** Retain the terminal outcome linked to the exact call, before handing it back to inference. */
const recordHostedToolOutcome = ({
  db,
  userId,
  identity,
  outcome,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  identity: ToolIdentity;
  outcome: CanonicalToolOutcome;
}>): Promise<Option.Option<HostedToolEvent>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const result = yield* Schema.decodeEffect(CanonicalToolResultEntry)({
        _tag: "CanonicalToolResultEntry",
        ...identity,
        id: TranscriptEntryId.make(newId()),
        outcome,
      });
      return (yield* appendHostedToolEntry({ db, userId, entry: result }))
        ? Option.some({
            _tag: "ToolResult",
            toolCallId: result.toolCallId,
            operation: result.operation,
            outcome: result.outcome,
          })
        : Option.none();
    })
  );

const serverErrorStatusMinimum = 500;

/** A missing response is not a failed mutation: the atomic fence is authoritative for a commit. */
const fencedMutationOutcome = ({
  db,
  userId,
  identity,
  response,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  identity: ToolIdentity;
  response: Response;
}>): Promise<CanonicalToolOutcome> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const outcome = yield* Effect.tryPromise(() => hostedResponseOutcome(response));
      if (outcome._tag === "Succeeded") return outcome;
      const committed = yield* Effect.tryPromise(() =>
        db
          .prepare(
            "SELECT 1 FROM hosted_mutation_commits WHERE user_id = ? AND turn_id = ? AND tool_call_id = ?"
          )
          .bind(userId, identity.turnId, identity.toolCallId)
          .first()
      );
      if (committed !== null) return { _tag: "CommittedOutputUnavailable" };
      // A server error can race a late canonical D1 commit. Keep the Turn Pending for its fence.
      if (response.status >= serverErrorStatusMinimum) {
        return yield* Effect.die(new Error("Uncertain canonical mutation"));
      }
      return outcome;
    })
  );

/** Dispatch only installed catalog operations, retaining exact call and outcome for this Pending Turn. */
const executeHostedTool = ({
  db,
  subject,
  bucket,
  executeMutation,
  userId,
  turnId,
  call,
  iteration,
  signal,
  mutation,
  deadlineMs,
}: Readonly<{
  db: D1Database;
  subject: HostedSubject;
  bucket: Option.Option<R2Bucket>;
  executeMutation: HostedTurnInput["executeMutation"];
  userId: UserId;
  turnId: TranscriptTurnId;
  call: HostedTextResult["toolCalls"][number];
  iteration: number;
  signal: AbortSignal;
  mutation: { started: boolean };
  deadlineMs: number;
}>): Promise<Option.Option<HostedToolAction>> => {
  const isExpired = (): boolean => signal.aborted || transactionNow() >= deadlineMs;
  return Effect.runPromise(
    Effect.gen(function* () {
      if (isExpired() || isWhatsAppHosted(subject)) return Option.none();
      const operation = hostedExecutableOperations.find(({ id }) => id === call.operation);
      const evidence = Schema.decodeUnknownOption(CanonicalToolEvidence)(call.params);
      const toolCallId = Schema.decodeOption(ToolCallId)(call.id);
      if (operation === undefined || Option.isNone(evidence) || Option.isNone(toolCallId)) {
        return Option.none();
      }
      const identity = {
        turnId,
        occurredAt: DateTime.formatIso(DateTime.makeUnsafe(transactionNow())),
        iteration,
        toolCallId: toolCallId.value,
        operation: operation.id,
      };
      const recorded = yield* Effect.tryPromise(() =>
        recordHostedToolCall({ db, userId, identity, input: evidence.value })
      );
      if (!recorded) return Option.none();
      const valid = Schema.decodeOption(operation.input)(evidence.value);
      if (
        Option.isNone(valid) ||
        (operation.id === atomicBatchOperation && !hostedBatchAllowed(evidence.value))
      ) {
        const rejected = yield* Effect.tryPromise(() =>
          recordHostedToolOutcome({
            db,
            userId,
            identity,
            outcome: {
              _tag: "ToolInputRejected",
              failure: { code: "validation_failed" },
            },
          })
        );
        return Option.map(rejected, (event): HostedToolAction => ({
          _tag: "Result",
          event,
          mutationSucceeded: false,
        }));
      }
      if (operation.policy.agentConfirmation === "required") {
        const challenge = yield* issueHostedConfirmation({
          db,
          userId,
          turnId,
          operation,
          input: evidence.value,
          now: transactionNow(),
        });
        const rejected = yield* Effect.tryPromise(() =>
          recordHostedToolOutcome({
            db,
            userId,
            identity,
            outcome: {
              _tag: "ToolInputRejected",
              failure: {
                code: Option.isSome(challenge)
                  ? "confirmation_required"
                  : "confirmation_unavailable",
              },
            },
          })
        );
        return Option.isSome(challenge) && Option.isSome(rejected)
          ? Option.some({ _tag: "Challenge", text: challenge.value.text })
          : Option.none();
      }
      let executed: Option.Option<Response>;
      if (operation.policy.kind === "mutation") {
        if (Option.isSome(executeMutation)) mutation.started = true;
        executed = Option.isSome(executeMutation)
          ? Option.some(
              yield* Effect.tryPromise(() =>
                executeMutation.value(operation.id, evidence.value, {
                  turnId: identity.turnId,
                  toolCallId: identity.toolCallId,
                })
              )
            )
          : Option.none();
      } else {
        executed = Option.getOrElse(
          yield* executeHostedQuery({
            db,
            subject,
            bucket,
            operation,
            input: evidence.value,
          }).pipe(
            Effect.timeoutOption(Duration.millis(Math.max(0, deadlineMs - transactionNow())))
          ),
          Option.none
        );
      }
      // The canonical owner may finish after our deadline; retain the attempted call's
      // unavailable outcome without claiming that its late Audit or result was delivered.
      if (operation.policy.kind === "query" && isExpired()) executed = Option.none();
      const outcome = Option.isSome(executed)
        ? yield* Effect.tryPromise(() =>
            operation.policy.kind === "mutation"
              ? fencedMutationOutcome({ db, userId, identity, response: executed.value })
              : hostedResponseOutcome(executed.value)
          )
        : {
            _tag: "ToolOutputRejected" as const,
            failure: { code: "canonical_result_unavailable" },
          };
      const event = yield* Effect.tryPromise(() =>
        recordHostedToolOutcome({ db, userId, identity, outcome })
      );
      if (
        operation.policy.kind === "mutation" &&
        outcome._tag !== "Succeeded" &&
        outcome._tag !== "CommittedOutputUnavailable" &&
        Option.isSome(event)
      ) {
        mutation.started = false;
      }
      return Option.map(event, (value): HostedToolAction => ({
        _tag: "Result",
        event: value,
        mutationSucceeded:
          operation.policy.kind === "mutation" &&
          (outcome._tag === "Succeeded" || outcome._tag === "CommittedOutputUnavailable"),
      }));
    })
  );
};

/** Redeem one User-authored exact command without giving the model authority to confirm it. */
const executeConfirmedHostedTurn = ({
  db,
  subject,
  userId,
  turnId,
  startedAtMs,
  challenge,
  executeMutation,
  signal,
  deliver,
  scheduleRecovery,
}: Readonly<{
  db: D1Database;
  subject: TransactionSubject;
  userId: UserId;
  turnId: TranscriptTurnId;
  startedAtMs: number;
  challenge: ConfirmationRow;
  executeMutation: HostedMutationExecutor;
  signal: AbortSignal;
  deliver: HostedDelivery;
  scheduleRecovery: HostedTurnInput["scheduleRecovery"];
}>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const finish = (result: HostedTurnOutcome): ReturnType<typeof finishHostedTurn> =>
        finishHostedTurn({
          db,
          userId,
          turnId,
          startedAtMs,
          result,
          subject,
          now: transactionNow(),
        });
      const mutation = { started: false };
      const expired = (): boolean =>
        signal.aborted || transactionNow() >= startedAtMs + maximumModelRoundMillis;
      return yield* Effect.gen(function* () {
        if (expired()) {
          yield* finish({ _tag: "Interrupted" });
          return unavailable();
        }
        const approved = yield* consumeHostedConfirmation({
          db,
          subject,
          turnId,
          challenge,
          now: transactionNow(),
        });
        if (Option.isNone(approved)) {
          yield* finish({ _tag: "Failed", reason: "HostedInferenceFailed" });
          return unauthenticated();
        }
        const operation = hostedExecutableOperations.find(
          ({ id }) => id === approved.value.operation
        );
        if (
          operation?.policy.kind !== "mutation" ||
          operation.policy.agentConfirmation !== "required" ||
          Option.isNone(Schema.decodeOption(operation.input)(approved.value.input)) ||
          (operation.id === atomicBatchOperation && !hostedBatchAllowed(approved.value.input))
        ) {
          yield* finish({ _tag: "Failed", reason: "HostedInferenceFailed" });
          return unavailable();
        }
        const identity = {
          turnId,
          occurredAt: DateTime.formatIso(DateTime.makeUnsafe(transactionNow())),
          iteration: 1,
          toolCallId: ToolCallId.make(newId()),
          operation: operation.id,
        };
        const saved = yield* Effect.tryPromise(() =>
          recordHostedToolCall({ db, userId, identity, input: approved.value.input })
        );
        if (!saved) {
          yield* finish({ _tag: "Failed", reason: "HostedInferenceFailed" });
          return unavailable();
        }
        if (expired()) {
          yield* finish({ _tag: "Interrupted" });
          return unavailable();
        }
        mutation.started = true;
        const response = yield* Effect.tryPromise(() =>
          executeMutation(operation.id, approved.value.input, {
            turnId: identity.turnId,
            toolCallId: identity.toolCallId,
          })
        );
        // A canonical commit can finish after the model-round deadline. Preserve its exact
        // outcome; recovery must not mistake the elapsed deadline for a failed mutation.
        const outcome = yield* Effect.tryPromise(() =>
          fencedMutationOutcome({ db, userId, identity, response })
        );
        const result = yield* Effect.tryPromise(() =>
          recordHostedToolOutcome({ db, userId, identity, outcome })
        );
        if (Option.isNone(result)) return unavailable();
        return yield* Effect.tryPromise(() =>
          proposeDelivery({
            db,
            userId,
            turnId,
            answer: TranscriptText.make(
              outcome._tag === "Succeeded" || outcome._tag === "CommittedOutputUnavailable"
                ? "Operación confirmada."
                : "No se pudo completar la operación."
            ),
            deliver: { _tag: "Browser", propose: deliver },
            finish,
            scheduleRecovery,
          })
        );
      }).pipe(
        Effect.catchCause(() =>
          Effect.gen(function* () {
            if (!mutation.started) {
              yield* Effect.exit(
                finish(
                  signal.aborted
                    ? { _tag: "Interrupted" }
                    : { _tag: "Failed", reason: "HostedInferenceFailed" }
                )
              );
            }
            // Once the owner begins, its fence and durable recovery decide an uncertain commit.
            return unavailable();
          })
        )
      );
    })
  );

const approvedAnswer = (result: HostedTextResult): Option.Option<TranscriptText> =>
  result.toolCalls.length === 0 && result.finishReason === "stop"
    ? Schema.decodeUnknownOption(TranscriptText)(result.text)
    : Option.none();

const proposeWhatsAppDelivery = ({
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
  deliver: WhatsAppHostedDelivery;
  finish: (outcome: HostedTurnOutcome) => ReturnType<typeof finishHostedTurn>;
  scheduleRecovery: (dueAtMs: number) => Promise<void>;
}>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      if (!(yield* isWhatsAppWindowOpen({ db, userId, turnId, now: transactionNow() }))) {
        yield* finish({ _tag: "Failed", reason: "DeliveryFailed" });
        return Response.json({ status: "delivery_failed" }, { status: 202, headers: noStore });
      }
      const token = yield* stageWhatsAppDelivery({
        db,
        userId,
        turnId,
        text: answer,
        now: transactionNow(),
      });
      if (Option.isNone(token)) return unavailable();
      yield* Effect.tryPromise(() =>
        scheduleRecovery(transactionNow() + deliveryAcknowledgmentWindowMs)
      );
      const started = yield* startWhatsAppSend({
        db,
        userId,
        turnId,
        token: token.value,
        now: transactionNow(),
      });
      if (!started) {
        yield* rejectUnstartedWhatsAppDelivery({ db, userId, turnId, token: token.value });
        yield* finish({ _tag: "Failed", reason: "DeliveryFailed" });
        return Response.json({ status: "delivery_failed" }, { status: 202, headers: noStore });
      }
      const sent = yield* Effect.tryPromise(() =>
        deliver.send({ text: answer, turnId, correlationToken: token.value })
      ).pipe(Effect.orElseSucceed(() => ({ kind: "ambiguous" as const })));
      const recorded = yield* recordWhatsAppSend({
        db,
        userId,
        turnId,
        token: token.value,
        outcome: sent,
      });
      if (sent.kind === "rejected" && recorded) {
        yield* finish({ _tag: "Failed", reason: "DeliveryFailed" });
      }
      return Response.json(
        { status: "awaiting_delivery", turnId },
        {
          status: 202,
          headers: noStore,
        }
      );
    })
  );

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
  deliver: ChannelDelivery;
  finish: (outcome: HostedTurnOutcome) => ReturnType<typeof finishHostedTurn>;
  scheduleRecovery: (dueAtMs: number) => Promise<void>;
}>): Promise<Response> =>
  deliver._tag === "WhatsApp"
    ? proposeWhatsAppDelivery({ db, userId, turnId, answer, deliver, finish, scheduleRecovery })
    : Effect.runPromise(
        Effect.gen(function* () {
          const receipt = yield* stageHostedDelivery({ db, userId, turnId, text: answer });
          yield* Effect.tryPromise(() =>
            scheduleRecovery(transactionNow() + deliveryAcknowledgmentWindowMs)
          );
          // The channel rejected the proposed reply. Nothing became visible.
          const delivered = yield* Effect.tryPromise(() =>
            deliver.propose({ text: answer, turnId, receipt })
          ).pipe(Effect.option);
          if (Option.isSome(delivered) && delivered.value.ok) return delivered.value;
          yield* finish({ _tag: "Failed", reason: "DeliveryFailed" });
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
      const acknowledged = yield* acknowledgeHostedDelivery({ db, subject, turnId, receipt });
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
/** A progress poll never admits or executes a second Turn. */
export const HostedProgressAdmission = Schema.Struct({
  userId: UserId,
  sessionId: Schema.String.check(Schema.isUUID()),
  digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
  ...HostedTurnProgressRequest.fields,
});

/** Read the outcome of one pending Turn under the same live WebSession authority. */
export const readHostedProgress = ({
  db,
  subject,
  turnId,
  scheduleRecovery,
}: Readonly<{
  db: D1Database;
  subject: TransactionSubject;
  turnId: TranscriptTurnId;
  scheduleRecovery: (dueAtMs: number) => Promise<void>;
}>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const now = transactionNow();
      const snapshot = yield* readHostedSnapshot({ db, subject, now });
      if (Option.isNone(snapshot)) return unauthenticated();
      const pending = snapshot.value.pending;
      if (Option.isNone(pending) || pending.value.id !== turnId) return interrupted();
      const due =
        pending.value.proposed_at_ms === null
          ? pending.value.started_at_ms + pendingExecutionRecoveryMs
          : pending.value.proposed_at_ms + deliveryAcknowledgmentWindowMs;
      if (now >= due) {
        yield* recoverHostedTurn({
          db,
          userId: UserId.make(subject.userId),
          turn: pending.value,
          now,
        });
        return interrupted();
      }
      if (pending.value.proposed_at_ms === null) {
        return Response.json({ status: "processing", turnId }, { status: 202, headers: noStore });
      }
      const refreshed = yield* refreshHostedDelivery({ db, subject, turnId });
      if (Option.isNone(refreshed)) return unavailable();
      yield* Effect.tryPromise(() => scheduleRecovery(due));
      return yield* Effect.tryPromise(() => browserHostedDelivery({ ...refreshed.value, turnId }));
    })
  );
/** Receipt forwarded by Core with a fresh WebSession proof, never from public input. */
export const HostedDeliveryAdmission = Schema.Struct({
  userId: UserId,
  sessionId: Schema.String.check(Schema.isUUID()),
  digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
  ...hostedDeliveryReceipt.fields,
});
/** No model or D1 work is bought for invalid input. */
export const invalidHostedTurn = invalid;
