import { type OwnedStatement } from "../../../src/shell/owner-write/contract";
import { readWeeklyPauseNotice } from "../../insights/operations";
import type { WhatsAppDocument } from "../../../src/shell/channels/whatsapp/contract";
import type { OutboundHttpService } from "../../../src/shell/outbound-http/operations";
import {
  prepareStatementDocumentReply,
  prepareStatementReadinessReply,
} from "./statement-document";
import {
  readHeldStatementDocument,
  readHeldStatementDocumentSubmission,
} from "../../ingestion/operations";
import { mintHostedStatementCaller } from "./statement-authority";
import { confirmedOutcome, findConfirmedCall, findConfirmedOutcome } from "./confirmed-outcome";
import { type HostedCommitFence, pendingExecutionRecoveryMs } from "../contract";
import {
  executeCanonicalQuery,
  installedCanonicalOperations,
  installedHostedStatementOperations,
} from "../../canonical-operations/operations";
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
  maximumHostedTurnIterations,
  maximumModelRoundMillis,
  maximumToolCallsPerTurn,
} from "../../../src/core/agent/contract";
import { UserId } from "../../../src/core/identity/contract";
import { readContextualProactiveReply } from "./proactive-transcript";
import {
  executeWhatsAppStatementQuery,
  whatsAppStatementMutationExecutor,
} from "./statement-execution";
import { assembleWorkingContext } from "./working-context";
import {
  compactionEntryTrigger,
  defaultCompactionMaximumTokens,
  shouldCompactConversation,
} from "../../../src/core/agent/operations";
import { atomicBatchOperation } from "../../../src/shell/operations/contract";
import { operationCatalog } from "../../../src/shell/api";
import {
  HostedInferenceError,
  type HostedInferenceService,
  type HostedTextResult,
  HostedToolCallMaximum,
  type PreparedHostedText,
} from "../../../src/shell/hosted-inference/contract";
import { Cause, DateTime, Duration, Effect, Exit, Option, Schema } from "effect";

import { decideOperationAccess } from "../../../src/shell/canonical-policy/operations";
import {
  type HostedDeliveryCorrelationToken,
  type WhatsAppProviderMessageId,
} from "../../../src/shell/channels/whatsapp/contract";
import { type TransactionSubject, transactionNow } from "../../canonical-work/operations";
import { newId } from "../../secret-material/operations";
import {
  type WhatsAppHostedSubject,
  type WhatsAppInboundEvidence,
  type WhatsAppUnavailable,
} from "../../whatsapp/contract";
import {
  isWhatsAppWindowOpen,
  readWhatsAppPendingWork,
  recordWhatsAppSend,
  rejectUnstartedWhatsAppDelivery,
  stageWhatsAppDelivery,
  startWhatsAppSend,
} from "../../whatsapp/operations";
import {
  type HostedSubject,
  hostedAuthority as heldAuthority,
  isWhatsAppHosted,
} from "./hosted-authority";
import {
  type ConfirmationRow,
  consumeHostedConfirmation,
  findHostedConfirmation,
  isHostedConfirmationAttempt,
  issueHostedConfirmation,
} from "./hosted-confirmation";
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
  readHostedContinuity,
  readHostedSnapshot,
  recoverHostedTurn,
  refreshHostedDelivery,
  reserveHostedCompaction,
  selectHostedSession,
  stageHostedDelivery,
} from "./turn-store";

// Only installed owners whose caller policy permits this authority enter the toolkit.
const hostedExecutableOperations = installedCanonicalOperations().filter(
  ({ policy }) =>
    decideOperationAccess(policy.access, {
      _tag: "HostedAgentSession",
      authorityRoot: "no-verified-whatsapp-authority",
    })._tag === "Allowed"
);

const executableOperationsFor = (
  subject: HostedSubject
): Readonly<typeof hostedExecutableOperations> =>
  isWhatsAppHosted(subject) ? installedHostedStatementOperations() : hostedExecutableOperations;

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
  contextualReplyQuery: Option.Option<OwnedStatement>;
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
type DocumentExecution = Readonly<{ document: WhatsAppDocument; outbound: OutboundHttpService }>;
type AdmittedTurnInput = Readonly<{ document: Option.Option<DocumentExecution> }> &
  Omit<HostedTurnInput, "subject" | "deliver"> &
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
  executeHostedTurn({ ...input, document: Option.none(), onAdmitted: Option.none() });
export const completeHostedTurnWithAdmission = ({
  input,
  onAdmitted,
}: Readonly<{
  input: HostedTurnInput;
  onAdmitted: (turnId: TranscriptTurnId) => void;
}>): Promise<Response> =>
  executeHostedTurn({ ...input, document: Option.none(), onAdmitted: Option.some(onAdmitted) });

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
    document: Option.none(),
    onAdmitted: Option.some(onAdmitted),
  });

/** Direct authenticated documents use this same Turn, delivery and installed canonical owner. */
export const completeWhatsAppDocumentTurnWithAdmission = ({
  input,
  onAdmitted,
}: Readonly<{
  input: Parameters<typeof completeWhatsAppTurnWithAdmission>[0]["input"] & DocumentExecution;
  onAdmitted: (turnId: TranscriptTurnId) => void;
}>): Promise<Response> =>
  executeHostedTurn({
    ...input,
    document: Option.some({ document: input.document, outbound: input.outbound }),
    onAdmitted: Option.some(onAdmitted),
  });

/** Continue only an admitted, still-pending User Turn; Queue contains no User content. */
const statementReadinessRetryMs = 30_000;
const waitForStatementReadiness = (
  scheduleRecovery: (at: number) => Promise<void>
): Effect.Effect<Response, Cause.UnknownError> =>
  Effect.tryPromise(() => scheduleRecovery(transactionNow() + statementReadinessRetryMs)).pipe(
    Effect.as(new Response(null, { status: 202 }))
  );

export const resumeWhatsAppTurn = ({
  db,
  userId,
  turnId,
  bucket,
  outbound,
  inference,
  deliver,
  signal,
  scheduleRecovery,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  turnId: TranscriptTurnId;
  bucket: Option.Option<R2Bucket>;
  outbound: OutboundHttpService;
  inference: HostedInferenceService;
  deliver: (
    recipient: Readonly<{
      bsuid: WhatsAppHostedSubject["bsuid"];
      businessPhoneNumberId: WhatsAppInboundEvidence["businessPhoneNumberId"];
      portfolioId: WhatsAppHostedSubject["portfolioId"];
      replyToMessageId: Option.Option<WhatsAppProviderMessageId>;
    }>
  ) => WhatsAppHostedDelivery;
  signal: AbortSignal;
  scheduleRecovery: (dueAtMs: number) => Promise<void>;
}>): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const work = yield* readWhatsAppPendingWork({ db, userId, turnId });
      if (Option.isNone(work)) return new Response(null, { status: 200 });
      const { startedAtMs, sessionId, portfolioId, bsuid, businessPhoneNumberId, text } =
        work.value;
      const subject: WhatsAppHostedSubject = {
        _tag: "WhatsAppHosted",
        userId,
        portfolioId,
        bsuid,
      };
      const now = transactionNow();
      const snapshot = yield* readHostedSnapshot({ db, subject, now });
      if (Option.isNone(snapshot) || !work.value.associationCurrent) {
        yield* finishHostedTurn({
          db,
          userId,
          turnId,
          startedAtMs,
          result: { _tag: "Interrupted" },
          subject,
          now,
        });
        return interrupted();
      }
      const caller = yield* mintHostedStatementCaller({
        db,
        subject,
        turnId,
        current: now,
        live: heldAuthority({ subject, current: now }),
        approval: Option.none(),
      });
      if (Option.isSome(caller) && Option.isSome(bucket)) {
        const document = yield* readHeldStatementDocument({ db, caller: caller.value });
        const submitted = yield* readHeldStatementDocumentSubmission({ db, caller: caller.value });
        if (Option.isSome(document) || Option.isSome(submitted)) {
          const answer = yield* prepareStatementDocumentReply({
            subject,
            db,
            bucket: bucket.value,
            caller: caller.value,
            outbound,
            businessPhoneNumberId,
            current: now,
          });
          if (Option.isNone(answer)) return yield* waitForStatementReadiness(scheduleRecovery);
          return yield* Effect.tryPromise(() =>
            proposeDelivery({
              db,
              userId,
              turnId,
              answer: answer.value,
              deliver: deliver(work.value),
              scheduleRecovery,
              finish: (result) =>
                finishHostedTurn({
                  db,
                  userId,
                  turnId,
                  startedAtMs,
                  result,
                  subject,
                  now: transactionNow(),
                }),
            })
          );
        }
      }
      if (isHostedConfirmationAttempt(text)) {
        const challenge = yield* findHostedConfirmation({
          db,
          userId,
          command: text,
          now,
          recoveringTurn: Option.some(turnId),
        });
        if (Option.isNone(challenge)) return unavailable();
        return yield* Effect.tryPromise(() =>
          executeConfirmedHostedTurn({
            db,
            subject,
            userId,
            turnId,
            startedAtMs,
            challenge: challenge.value,
            executeMutation: whatsAppStatementMutationExecutor({ db, bucket, subject }),
            signal,
            deliver: deliver(work.value),
            scheduleRecovery,
          })
        );
      }
      const prepared = yield* Effect.tryPromise(() =>
        prepareHostedWork({
          db,
          subject,
          selection: { id: sessionId },
          snapshot: snapshot.value,
          userId,
          activeTurnId: turnId,
          startedAtMs,
          text,
          inference,
          signal,
          executeMutation: Option.some(whatsAppStatementMutationExecutor({ db, bucket, subject })),
          admittedWhatsAppTurn: Option.some(turnId),
          contextualReplyQuery: deliver(work.value).contextualReplyQuery,
        })
      );
      if (Option.isNone(prepared)) {
        if (!signal.aborted) {
          yield* finishHostedTurn({
            db,
            userId,
            turnId,
            startedAtMs,
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
          bucket,
          executeMutation: Option.some(whatsAppStatementMutationExecutor({ db, bucket, subject })),
          startedAtMs,
          prepared: prepared.value,
          deliver: deliver(work.value),
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
const admissionChannel = (input: AdmittedTurnInput): HostedAdmissionChannel => {
  if (!("inbound" in input)) return { _tag: "Browser", subject: input.subject };
  if (Option.isSome(input.document)) {
    return {
      _tag: "WhatsAppDocument",
      subject: input.subject,
      inbound: input.inbound,
      document: input.document.value.document,
    };
  }
  return { _tag: "WhatsApp", subject: input.subject, inbound: input.inbound };
};
const executeHostedTurn = (input: AdmittedTurnInput): Promise<Response> => {
  const channel = admissionChannel(input);
  const {
    db,
    subject,
    bucket,
    executeMutation: browserMutation,
    text,
    inference,
    signal,
    scheduleRecovery,
    onAdmitted,
  } = input;
  const executeMutation = isWhatsAppHosted(subject)
    ? Option.some(whatsAppStatementMutationExecutor({ db, bucket, subject }))
    : browserMutation;
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
      if (isHostedConfirmationAttempt(text)) {
        const challenge = yield* findHostedConfirmation({
          db,
          userId,
          command: text,
          now: startedAtMs,
          recoveringTurn: Option.none(),
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
            deliver:
              "inbound" in input ? input.deliver : { _tag: "Browser", propose: input.deliver },
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
          contextualReplyQuery:
            "inbound" in input ? input.deliver.contextualReplyQuery : Option.none(),
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
      if (Option.isSome(input.document) && "inbound" in input && Option.isSome(bucket)) {
        if (Option.isSome(onAdmitted)) onAdmitted.value(turn.value);
        yield* Effect.tryPromise(() => scheduleRecovery(startedAtMs + pendingExecutionRecoveryMs));
        const caller = yield* mintHostedStatementCaller({
          db,
          subject: input.subject,
          turnId: turn.value,
          current: transactionNow(),
          live: heldAuthority({ subject: input.subject, current: transactionNow() }),
          approval: Option.none(),
        });
        if (Option.isNone(caller)) return unavailable();
        const answer = yield* prepareStatementDocumentReply({
          subject: input.subject,
          db,
          bucket: bucket.value,
          caller: caller.value,
          outbound: input.document.value.outbound,
          businessPhoneNumberId: input.inbound.businessPhoneNumberId,
          current: transactionNow(),
        });
        if (Option.isNone(answer)) return yield* waitForStatementReadiness(scheduleRecovery);
        return yield* Effect.tryPromise(() =>
          proposeDelivery({
            db,
            userId,
            turnId: turn.value,
            answer: answer.value,
            deliver: input.deliver,
            scheduleRecovery,
            finish: (result) =>
              finishHostedTurn({
                db,
                userId,
                turnId: turn.value,
                startedAtMs,
                result,
                subject,
                now: transactionNow(),
              }),
          })
        );
      }
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
  contextualReplyQuery: Option.Option<OwnedStatement>;
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
  contextualReplyQuery,
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
      const proactiveReply = yield* readContextualProactiveReply({
        db,
        userId,
        now: startedAtMs,
        proof: contextualReplyQuery,
      });
      const context = assembleWorkingContext({
        sessionId: selection.id,
        userId,
        activeTurnId,
        user: snapshot.user,
        startedAt: DateTime.makeUnsafe(startedAtMs),
        memories: continuity.memories,
        compactedConversation: continuity.compactedConversation,
        transcript: continuity.transcript.filter(({ entry }) => entry.turnId !== activeTurnId),
        proactiveReply,
        activeRequest: text,
      });
      const prepared = yield* Effect.tryPromise(() =>
        Effect.runPromiseExit(
          inference.prepareText({
            context,
            toolChoice: "auto",
            maximumToolCalls: HostedToolCallMaximum.make(maximumToolCallsPerTurn),
            availableOperations: executableOperationsFor(subject)
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
}>): Effect.Effect<
  "clear" | "awaiting" | "error",
  Cause.UnknownError | Schema.SchemaError | WhatsAppUnavailable
> => {
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
      ): Effect.Effect<Response, Cause.UnknownError | Schema.SchemaError | WhatsAppUnavailable> =>
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
  subject,
  identity,
  input,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  subject: HostedSubject;
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
      return Option.isSome(yield* appendHostedToolEntry({ db, userId, subject, entry }));
    })
  );

/** Retain the terminal outcome linked to the exact call, before handing it back to inference. */
const recordHostedToolOutcome = ({
  db,
  userId,
  subject,
  identity,
  outcome,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  subject: HostedSubject;
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
      const published = yield* appendHostedToolEntry({ db, userId, subject, entry: result });
      if (Option.isNone(published) || published.value._tag !== "CanonicalToolResultEntry") {
        return Option.none();
      }
      return Option.some({
        _tag: "ToolResult",
        toolCallId: published.value.toolCallId,
        operation: published.value.operation,
        outcome: published.value.outcome,
      });
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

const executeConfirmedMutation = ({
  db,
  userId,
  identity,
  input,
  executeMutation,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  identity: ToolIdentity;
  input: CanonicalToolEvidence;
  executeMutation: HostedMutationExecutor;
}>): Effect.Effect<CanonicalToolOutcome, Cause.UnknownError> =>
  Effect.gen(function* () {
    const response = yield* Effect.tryPromise(() =>
      executeMutation(identity.operation, input, {
        turnId: identity.turnId,
        toolCallId: identity.toolCallId,
      })
    );
    return yield* Effect.tryPromise(() =>
      fencedMutationOutcome({ db, userId, identity, response })
    );
  });

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
      if (isExpired()) return Option.none();
      const operation = executableOperationsFor(subject).find(({ id }) => id === call.operation);
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
        recordHostedToolCall({ db, userId, subject, identity, input: evidence.value })
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
            subject,
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
            subject,
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
          yield* (
            isWhatsAppHosted(subject)
              ? executeWhatsAppStatementQuery({
                  db,
                  subject,
                  bucket,
                  turnId,
                  operation: operation.id,
                  input: evidence.value,
                })
              : executeCanonicalQuery({
                  db,
                  subject,
                  bucket,
                  operation: operation.id,
                  input: evidence.value,
                })
          ).pipe(Effect.timeoutOption(Duration.millis(Math.max(0, deadlineMs - transactionNow())))),
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
        recordHostedToolOutcome({ db, userId, subject, identity, outcome })
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
const confirmedStatementReply = ({
  db,
  subject,
  turnId,
  operation,
}: Readonly<{
  db: D1Database;
  subject: HostedSubject;
  turnId: TranscriptTurnId;
  operation: string;
}>): Effect.Effect<Option.Option<TranscriptText>> =>
  Effect.gen(function* () {
    if (!isWhatsAppHosted(subject)) return Option.none();
    if (operation === "ingestion.abandonStatementSubmission") {
      return Option.some(
        TranscriptText.make(
          "Se abandonó lo pendiente del extracto. Las Transacciones ya capturadas se conservan."
        )
      );
    }
    if (
      operation !== "ingestion.resolveNeedsReviewItem" &&
      operation !== "ingestion.skipNeedsReviewItem"
    ) {
      return Option.none();
    }
    const current = transactionNow();
    const caller = yield* mintHostedStatementCaller({
      db,
      subject,
      turnId,
      current,
      live: heldAuthority({ subject, current }),
      approval: Option.none(),
    });
    if (Option.isNone(caller)) return Option.none();
    return Option.some(
      yield* prepareStatementReadinessReply({
        db,
        caller: caller.value,
        bucket: Option.none(),
        current,
      })
    );
  }).pipe(Effect.orElseSucceed(() => Option.none()));
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
  subject: HostedSubject;
  userId: UserId;
  turnId: TranscriptTurnId;
  startedAtMs: number;
  challenge: ConfirmationRow;
  executeMutation: HostedMutationExecutor;
  signal: AbortSignal;
  deliver: ChannelDelivery;
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
      // Server-side confirmation recovery makes no model call. Bound this execution attempt,
      // not the original model round; owner authority still enforces the permanent session boundary.
      const executionDeadline = transactionNow() + maximumModelRoundMillis;
      const expired = (): boolean => signal.aborted || transactionNow() >= executionDeadline;
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
        const operation = executableOperationsFor(subject).find(
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
        const retainedCall = yield* findConfirmedCall({
          db,
          userId,
          turnId,
          operation: operation.id,
          input: approved.value.input,
        });
        const identity = {
          turnId,
          occurredAt: DateTime.formatIso(DateTime.makeUnsafe(transactionNow())),
          iteration: 1,
          toolCallId: Option.getOrElse(retainedCall, () =>
            ToolCallId.make(`confirmation:${challenge.id}`)
          ),
          operation: operation.id,
        };
        const saved =
          Option.isSome(retainedCall) ||
          (yield* Effect.tryPromise(() =>
            recordHostedToolCall({ db, userId, subject, identity, input: approved.value.input })
          ));
        if (!saved) {
          yield* finish({ _tag: "Failed", reason: "HostedInferenceFailed" });
          return unavailable();
        }
        if (expired()) {
          yield* finish({ _tag: "Interrupted" });
          return unavailable();
        }
        mutation.started = true;
        const retainedOutcome = yield* findConfirmedOutcome({ db, userId, ...identity });
        const outcome = yield* Option.isSome(retainedOutcome)
          ? Effect.succeed(confirmedOutcome(retainedOutcome.value))
          : executeConfirmedMutation({
              db,
              userId,
              identity,
              input: approved.value.input,
              executeMutation,
            });
        if (Option.isNone(retainedOutcome) || retainedOutcome.value._tag === "CommitUnrecorded") {
          const result = yield* Effect.tryPromise(() =>
            recordHostedToolOutcome({ db, userId, subject, identity, outcome })
          );
          if (Option.isNone(result)) return unavailable();
        }
        const succeeded =
          outcome._tag === "Succeeded" || outcome._tag === "CommittedOutputUnavailable";
        const clarification = succeeded
          ? yield* confirmedStatementReply({ db, subject, turnId, operation: operation.id })
          : Option.none();
        const answer = Option.getOrElse(clarification, () =>
          TranscriptText.make(
            succeeded ? "Operación confirmada." : "No se pudo completar la operación."
          )
        );

        return yield* Effect.tryPromise(() =>
          proposeDelivery({
            db,
            userId,
            turnId,
            answer,
            deliver,
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

const proposeChannelDelivery = ({
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

/** The pause notice is fixed product copy, never a model-generated claim or proactive new Session. */
const proposeDelivery = (input: Parameters<typeof proposeChannelDelivery>[0]): Promise<Response> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const notice = yield* readWeeklyPauseNotice({
        db: input.db,
        userId: input.userId,
        turnId: input.turnId,
      });
      const answer = Option.isNone(notice)
        ? input.answer
        : yield* Schema.decodeEffect(TranscriptText)(`${notice.value}\n\n${input.answer}`);
      return yield* Effect.tryPromise(() => proposeChannelDelivery({ ...input, answer }));
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
/** No model or D1 work is bought for invalid input. */
export const invalidHostedTurn = invalid;
