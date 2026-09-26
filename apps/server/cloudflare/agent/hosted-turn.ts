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
  admitHostedTurn,
  finishHostedTurn,
  readHostedContinuity,
  readHostedSnapshot,
  recoverHostedTurn,
  selectHostedSession,
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

/** The channel must acknowledge a visible reply before the Turn is terminalized as Completed. */
export type HostedDelivery = (text: TranscriptText) => Promise<Response>;

/** Render a bounded, inert JSON text response for the authenticated browser channel. */
export const browserHostedDelivery: HostedDelivery = (text) =>
  Promise.resolve(Response.json({ text }, { status: 200, headers: noStore }));

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
  const current = transactionNow();
  const initial = await readHostedSnapshot(db, subject, current);
  if (Option.isNone(initial)) return unauthenticated();
  const recovered = await recoverPending({
    db,
    userId,
    pending: initial.value.pending,
    now: current,
  });
  if (!recovered) return unavailable();
  const fresh = await readHostedSnapshot(db, subject, transactionNow());
  if (Option.isNone(fresh)) return unauthenticated();
  if (fresh.value.revoked) return consentRequired();
  const startedAtMs = transactionNow();
  const selection = selectHostedSession(fresh.value, userId, startedAtMs);
  const activeTurnId = TranscriptTurnId.make(newId());
  const prepared = await prepareHostedWork({
    db,
    subject,
    selection,
    snapshot: fresh.value,
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
}>): Promise<boolean> =>
  Option.isNone(pending)
    ? Promise.resolve(true)
    : recoverHostedTurn({ db, userId, turn: pending.value, now });

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
  return deliverAndFinish(answer.value, deliver, finish);
};

const approvedAnswer = (result: HostedTextResult): Option.Option<TranscriptText> =>
  result.toolCalls.length === 0 && result.finishReason === "stop"
    ? Schema.decodeUnknownOption(TranscriptText)(result.text)
    : Option.none();

// @effect-diagnostics-next-line asyncFunction:off
const deliverAndFinish = async (
  answer: TranscriptText,
  deliver: HostedDelivery,
  finish: (result: HostedTurnOutcome) => Promise<boolean>
): Promise<Response> => {
  let response: Response;
  try {
    response = await deliver(answer);
    if (!response.ok) {
      await finish({ _tag: "Failed", reason: "DeliveryFailed" });
      return unavailable();
    }
  } catch {
    await finish({ _tag: "Failed", reason: "DeliveryFailed" });
    return unavailable();
  }
  return (await finish({ _tag: "Completed", text: answer })) ? response : unavailable();
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
/** No model or D1 work is bought for invalid input. */
export const invalidHostedTurn = invalid;
