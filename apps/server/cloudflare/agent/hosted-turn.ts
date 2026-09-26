import {
  TranscriptText,
  TranscriptTurnId,
  UserId,
  assembleWorkingContext,
} from "@fidy/server/agent-runtime";
import type {
  HostedInferenceService,
  HostedTextResult,
  PreparedHostedText,
} from "@fidy/server/hosted-inference";
import { Cause, DateTime, Effect, Exit, Option, Schema } from "effect";
import type { TransactionSubject } from "../transactions/transaction-boundary";
import { transactionNow } from "../transactions/transaction-boundary";
import { newId } from "../pats/pat-shared";
import {
  type HostedTurnOutcome,
  type HostedTurnSnapshot,
  acknowledgeHostedDelivery,
  admitHostedTurn,
  finishHostedTurn,
  readHostedContinuity,
  readHostedSnapshot,
  recoverHostedTurn,
  selectHostedSession,
  stageHostedDelivery,
} from "./turn-store";

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
}>;

/**
 * Own one no-tool hosted Turn under the per-User Durable Object's serialized request. D1 owns
 * admission and exact evidence; the adapter owns the single provider round and delivery. A lost
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
  return executeAdmittedTurn({
    db,
    userId,
    turnId: turn.value,
    startedAtMs,
    prepared: prepared.value,
    deliver,
    signal,
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
  const continuity = await readHostedContinuity({
    db,
    subject,
    sessionId: selection.id,
    now: startedAtMs,
  });
  const context = assembleWorkingContext({
    sessionId: selection.id,
    userId,
    activeTurnId,
    user: snapshot.user,
    startedAt: DateTime.makeUnsafe(startedAtMs),
    memories: continuity.memories,
    compactedConversation: Option.none(),
    transcript: continuity.transcript,
    activeRequest: text,
  });
  const prepared = await Effect.runPromiseExit(
    inference.prepareText({
      context,
      toolChoice: "none",
      availableOperations: [],
    }),
    { signal }
  );
  return Exit.isFailure(prepared) || signal.aborted ? Option.none() : Option.some(prepared.value);
};

const deliveryAcknowledgmentWindowMs = 120_000;
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
  turnId: TranscriptTurnId;
  startedAtMs: number;
  prepared: PreparedHostedText;
  deliver: HostedDelivery;
  signal: AbortSignal;
}>;

/** The only path allowed to terminalize a Pending Turn. */
// @effect-diagnostics-next-line asyncFunction:off
const executeAdmittedTurn = async ({
  db,
  userId,
  turnId,
  startedAtMs,
  prepared,
  deliver,
  signal,
}: AdmittedWork): Promise<Response> => {
  const finish = (result: HostedTurnOutcome): Promise<boolean> =>
    finishHostedTurn({ db, userId, turnId, startedAtMs, result, now: transactionNow() });
  const generated = await Effect.runPromiseExit(
    prepared.execute.pipe(Effect.timeout("120 seconds")),
    { signal }
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
  const answer = approvedAnswer(generated.value);
  if (Option.isNone(answer)) {
    await finish({ _tag: "Failed", reason: "HostedInferenceFailed" });
    return unavailable();
  }
  return proposeDelivery({ db, userId, turnId, answer: answer.value, deliver, finish });
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
}: Readonly<{
  db: D1Database;
  userId: UserId;
  turnId: TranscriptTurnId;
  answer: TranscriptText;
  deliver: HostedDelivery;
  finish: (outcome: HostedTurnOutcome) => Promise<boolean>;
}>): Promise<Response> => {
  const receipt = await stageHostedDelivery({ db, userId, turnId, text: answer });
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
export const hostedTurnInput = Schema.Struct({ text: TranscriptText });
/** Bounded Core-to-DO admission with explicit User identity and ephemeral credential proof. */
export const HostedTurnAdmission = Schema.Struct({
  userId: UserId,
  sessionId: Schema.String.check(Schema.isUUID()),
  digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
  text: TranscriptText,
});
/** The browser sends this receipt only after it has visibly rendered the exact reply. */
export const hostedDeliveryReceipt = Schema.Struct({
  turnId: TranscriptTurnId,
  receipt: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
});
/** Receipt forwarded by Core with a fresh WebSession proof, never from public input. */
export const HostedDeliveryAdmission = Schema.Struct({
  userId: UserId,
  sessionId: Schema.String.check(Schema.isUUID()),
  digest: Schema.Array(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 255 }))),
  ...hostedDeliveryReceipt.fields,
});
/** No model or D1 work is bought for invalid input. */
export const invalidHostedTurn = invalid;
