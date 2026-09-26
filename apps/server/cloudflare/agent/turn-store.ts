import {
  AssistantTranscriptEntry,
  DisclosureSnapshot,
  FailedTurnTranscriptEntry,
  type HostedAdmissionState,
  HostedAgentSessionConsentBasis,
  HostedAgentSessionId,
  IanaTimeZone,
  Locale,
  ServiceMarket,
  type SessionTranscriptEntry,
  TranscriptEntry,
  TranscriptEntryId,
  TranscriptText,
  TranscriptTurnId,
  TurnFailureReason,
  UserId,
  UserTranscriptEntry,
  decideHostedAdmission,
  memoriesFromRows,
  memoryRowsQuery,
} from "@fidy/server/agent-runtime";
import { DateTime, Option, Schema } from "effect";
import type { TransactionSubject } from "../transactions/transaction-boundary";
import { callerAuthority, transactionNow } from "../transactions/transaction-boundary";
import { newId } from "../pats/pat-shared";

const maximumRetainedEntries = 200;
const maximumCurrentMemories = 100;
const millisecondsPerDay = 86_400_000;
const maximumDailyTurns = 50;
const receiptBytes = 32;
const hexRadix = 16;
const SessionRow = Schema.Struct({
  id: HostedAgentSessionId,
  user_id: UserId,
  consent_basis_json: Schema.String,
  started_at_ms: Schema.Int,
  last_activity_at_ms: Schema.NullOr(Schema.Int),
  status: Schema.Literals(["active", "idle-ended", "revoked"]),
});
const TurnRow = Schema.Struct({
  id: TranscriptTurnId,
  started_at_ms: Schema.Int,
  proposed_at_ms: Schema.NullOr(Schema.Int),
});
const ConsentUserRow = Schema.Struct({
  service_market: ServiceMarket,
  locale: Locale,
  time_zone: IanaTimeZone,
  id: Schema.String,
  disclosure_json: Schema.String,
  revoked: Schema.Int,
});
const EntryRow = Schema.Struct({
  sequence: Schema.Int,
  id: TranscriptEntryId,
  turn_id: TranscriptTurnId,
  occurred_at_ms: Schema.Int,
  kind: Schema.Literals(["user", "assistant", "failed", "interrupted"]),
  text: Schema.NullOr(Schema.String),
  failure_reason: Schema.NullOr(TurnFailureReason),
});

type ConsentUserRow = typeof ConsentUserRow.Type;
type SessionRow = typeof SessionRow.Type;
type TurnRow = typeof TurnRow.Type;
type EntryRow = typeof EntryRow.Type;

/** No decoded private data is returned when the current credential or Consent is not live. */
export type HostedTurnSnapshot = Readonly<{
  user: Readonly<{
    serviceMarket: ConsentUserRow["service_market"];
    locale: ConsentUserRow["locale"];
    timeZone: ConsentUserRow["time_zone"];
  }>;
  consentBasis: HostedAgentSessionConsentBasis;
  revoked: boolean;
  capacityAvailable: boolean;
  session: Option.Option<SessionRow>;
  pending: Option.Option<TurnRow>;
}>;

const decodeConsent = (row: ConsentUserRow): HostedAgentSessionConsentBasis => {
  const disclosure = Schema.decodeSync(Schema.fromJsonString(DisclosureSnapshot))(
    row.disclosure_json
  );
  return Schema.decodeSync(HostedAgentSessionConsentBasis)({
    grantId: row.id,
    disclosureRevision: disclosure.revision,
    disclosureSha256: disclosure.contentSha256,
    policyRevision: disclosure.policy.revision,
    policySha256: disclosure.policy.contentSha256,
  });
};

/** Read a live WebSession's current Consent and the latest hosted lifecycle, for one explicit User. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const readHostedSnapshot = async (
  db: D1Database,
  subject: TransactionSubject,
  now: number
): Promise<Option.Option<HostedTurnSnapshot>> => {
  const raw = await db
    .prepare(`SELECT u.service_market, u.locale, u.time_zone, c.id, c.disclosure_json,
      EXISTS (SELECT 1 FROM consent_user_revocations WHERE user_id = u.id) AS revoked
      FROM users AS u JOIN onboarding_consent_records AS c ON c.user_id = u.id
      JOIN web_sessions AS w ON w.user_id = u.id
      WHERE u.id = ? AND w.id = ? AND w.token_digest = ? AND w.revoked_at_ms IS NULL
        AND w.idle_expires_at_ms > ? AND w.hard_expires_at_ms > ?`)
    .bind(subject.userId, subject.id, subject.digest, now, now)
    .first();
  if (raw === null) return Option.none();
  const user = Schema.decodeUnknownSync(ConsentUserRow)(raw);
  const sessionRaw = await db
    .prepare(`SELECT id, user_id, consent_basis_json, started_at_ms, last_activity_at_ms, status
      FROM hosted_agent_sessions WHERE user_id = ?
      ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, started_at_ms DESC, id DESC LIMIT 1`)
    .bind(subject.userId)
    .first();
  const pendingRaw = await db
    .prepare(`SELECT id, started_at_ms,
      (SELECT proposed_at_ms FROM hosted_delivery_proposals WHERE turn_id = hosted_turns.id) AS proposed_at_ms
      FROM hosted_turns WHERE user_id = ? AND status = 'pending'`)
    .bind(subject.userId)
    .first();
  const day = Math.floor(now / millisecondsPerDay) * millisecondsPerDay;
  const budget = await db
    .prepare(`SELECT COUNT(*) AS used FROM hosted_turns
    WHERE user_id = ? AND started_at_ms >= ? AND started_at_ms < ?`)
    .bind(subject.userId, day, day + millisecondsPerDay)
    .first<{ used: number }>();
  return Option.some({
    user: { serviceMarket: user.service_market, locale: user.locale, timeZone: user.time_zone },
    consentBasis: decodeConsent(user),
    revoked: user.revoked === 1,
    capacityAvailable: (budget?.used ?? maximumDailyTurns) < maximumDailyTurns,
    session: Option.fromNullishOr(sessionRaw).pipe(
      Option.map(Schema.decodeUnknownSync(SessionRow))
    ),
    pending: Option.fromNullishOr(pendingRaw).pipe(Option.map(Schema.decodeUnknownSync(TurnRow))),
  });
};

/** Recovery works even after revocation: it never admits new work or sends User content. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const recoverHostedTurn = async ({
  db,
  userId,
  turn,
  now,
}: Readonly<{ db: D1Database; userId: UserId; turn: TurnRow; now: number }>): Promise<boolean> => {
  const timestamp = Math.max(now, turn.started_at_ms);
  const marker = TranscriptEntryId.make(newId());
  const results = await db.batch([
    db
      .prepare(`INSERT INTO transcript_entries
      (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms)
      SELECT ?, user_id, hosted_session_id, id, 'interrupted', ? FROM hosted_turns
      WHERE id = ? AND user_id = ? AND status = 'pending'`)
      .bind(marker, timestamp, turn.id, userId),
    db
      .prepare(`UPDATE hosted_turns SET status = 'interrupted', terminal_at_ms = ?
      WHERE id = ? AND user_id = ? AND status = 'pending'`)
      .bind(timestamp, turn.id, userId),
    db
      .prepare(`DELETE FROM hosted_delivery_proposals WHERE turn_id = ? AND user_id = ?`)
      .bind(turn.id, userId),
    // A recovered Pending Turn's activity was its start, not this recovery instant.
    db
      .prepare(`UPDATE hosted_agent_sessions SET last_activity_at_ms = ? WHERE user_id = ?
      AND id = (SELECT hosted_session_id FROM hosted_turns WHERE id = ? AND user_id = ?)`)
      .bind(turn.started_at_ms, userId, turn.id, userId),
  ]);
  return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1;
};

const admissionState = (snapshot: HostedTurnSnapshot): HostedAdmissionState => ({
  session: Option.map(snapshot.session, (session) => ({
    id: session.id,
    userId: session.user_id,
    consentBasis: Schema.decodeSync(Schema.fromJsonString(HostedAgentSessionConsentBasis))(
      session.consent_basis_json
    ),
    startedAtMs: session.started_at_ms,
    lastActivityAtMs: Option.fromNullishOr(session.last_activity_at_ms),
    status: session.status,
  })),
  pendingStartedAtMs: Option.map(snapshot.pending, (turn) => turn.started_at_ms),
});

/** The one session selection used for both preflight and the guarded admission batch. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const selectHostedSession = (
  snapshot: HostedTurnSnapshot,
  userId: UserId,
  now: number
): Readonly<{
  id: HostedAgentSessionId;
  create: boolean;
  basis: HostedAgentSessionConsentBasis;
}> => {
  const decision = decideHostedAdmission({
    userId,
    nowMs: now,
    currentConsent: snapshot.revoked ? Option.none() : Option.some(snapshot.consentBasis),
    revoked: snapshot.revoked,
    state: admissionState(snapshot),
  });
  if (decision._tag === "ContinueSession") {
    return {
      id: decision.sessionId,
      create: false,
      basis: Option.getOrThrow(admissionState(snapshot).session).consentBasis,
    };
  }
  if (decision._tag !== "BeginSession") throw new Error("Hosted admission is not available");
  return { id: HostedAgentSessionId.make(newId()), create: true, basis: decision.consentBasis };
};

/** Read current Memories and exact retained entries only for the selected User and session. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const readHostedContinuity = async ({
  db,
  subject,
  sessionId,
  now,
}: Readonly<{
  db: D1Database;
  subject: TransactionSubject;
  sessionId: HostedAgentSessionId;
  now: number;
}>): Promise<
  Readonly<{
    memories: ReadonlyArray<Readonly<{ text: string }>>;
    transcript: ReadonlyArray<SessionTranscriptEntry>;
  }>
> => {
  const authority = callerAuthority({ subject, current: now });
  const query = memoryRowsQuery({ userId: subject.userId, authority });
  const memoryRows = await db
    .prepare(query.sql)
    .bind(...query.params)
    .all();
  const memories = Option.getOrThrow(memoriesFromRows(memoryRows.results));
  if (memories.length > maximumCurrentMemories) throw new Error("Hosted Memory capacity exceeded");
  const raw = await db
    .prepare(`SELECT sequence, id, turn_id, occurred_at_ms, kind, text, failure_reason
    FROM transcript_entries WHERE user_id = ? AND hosted_session_id = ?
    ORDER BY sequence LIMIT ?`)
    .bind(subject.userId, sessionId, maximumRetainedEntries + 1)
    .all();
  if (raw.results.length > maximumRetainedEntries) {
    throw new Error("Hosted Transcript capacity exceeded");
  }
  const entries = Schema.decodeUnknownSync(Schema.Array(EntryRow))(raw.results);
  return {
    memories: memories.map(({ text }) => ({ text })),
    transcript: entries.map((row) => ({
      userId: UserId.make(subject.userId),
      sessionId,
      sequence: BigInt(row.sequence),
      entry: decodeEntry(row),
    })),
  };
};

const decodeEntry = (row: EntryRow): TranscriptEntry => {
  const identity = {
    id: row.id,
    turnId: row.turn_id,
    occurredAt: DateTime.formatIso(DateTime.makeUnsafe(row.occurred_at_ms)),
  };
  switch (row.kind) {
    case "user":
      return Schema.decodeUnknownSync(UserTranscriptEntry)({
        _tag: "UserTranscriptEntry",
        ...identity,
        text: row.text,
      });
    case "assistant":
      return Schema.decodeUnknownSync(AssistantTranscriptEntry)({
        _tag: "AssistantTranscriptEntry",
        ...identity,
        iteration: 1,
        text: row.text,
      });
    case "failed":
      return Schema.decodeUnknownSync(FailedTurnTranscriptEntry)({
        _tag: "FailedTurnTranscriptEntry",
        ...identity,
        reason: row.failure_reason,
      });
    case "interrupted":
      return Schema.decodeSync(TranscriptEntry)({
        _tag: "InterruptedTurnTranscriptEntry",
        ...identity,
      });
  }
};

/** Append the exact User entry and Pending Turn atomically after the complete model preflight. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const admitHostedTurn = async ({
  db,
  subject,
  selection,
  text,
  now,
  id,
}: Readonly<{
  db: D1Database;
  subject: TransactionSubject;
  selection: ReturnType<typeof selectHostedSession>;
  text: TranscriptText;
  now: number;
  id: TranscriptTurnId;
}>): Promise<Option.Option<TranscriptTurnId>> => {
  const entryId = TranscriptEntryId.make(newId());
  const authority = callerAuthority({ subject, current: now });
  const createSession = selection.create
    ? db
        .prepare(`INSERT INTO hosted_agent_sessions
        (id, user_id, consent_basis_json, started_at_ms, status)
        SELECT ?, user_id, ?, ?, 'active' FROM ${authority.table} WHERE ${authority.predicate}`)
        .bind(
          selection.id,
          JSON.stringify(
            Schema.encodeSync(Schema.toCodecJson(HostedAgentSessionConsentBasis))(selection.basis)
          ),
          now,
          ...authority.bindings
        )
    : db
        .prepare(
          `UPDATE hosted_agent_sessions SET status = 'active' WHERE id = ? AND user_id = ? AND status = 'active'`
        )
        .bind(selection.id, subject.userId);
  const results = await db.batch([
    createSession,
    db
      .prepare(`INSERT INTO hosted_turns (id, user_id, hosted_session_id, started_at_ms, status)
      SELECT ?, user_id, ?, ?, 'pending' FROM ${authority.table} WHERE ${authority.predicate}`)
      .bind(id, selection.id, now, ...authority.bindings),
    db
      .prepare(`INSERT INTO transcript_entries
      (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, text)
      SELECT ?, user_id, hosted_session_id, id, 'user', ?, ? FROM hosted_turns
      WHERE id = ? AND user_id = ? AND status = 'pending'`)
      .bind(entryId, now, text, id, subject.userId),
    db
      .prepare(`UPDATE hosted_agent_sessions SET status = 'idle-ended'
      WHERE user_id = ? AND id <> ? AND status = 'active'`)
      .bind(subject.userId, selection.id),
  ]);
  return results[0]?.meta.changes === 1 &&
    results[1]?.meta.changes === 1 &&
    results[2]?.meta.changes === 1
    ? Option.some(id)
    : Option.none();
};

const receiptHash = (receipt: string): Promise<Uint8Array> =>
  crypto.subtle
    .digest("SHA-256", new TextEncoder().encode(receipt))
    .then((value) => new Uint8Array(value));

/** Reserve one exact provider answer; this is not yet Transcript evidence. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const stageHostedDelivery = async ({
  db,
  userId,
  turnId,
  text,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  turnId: TranscriptTurnId;
  text: TranscriptText;
}>): Promise<string> => {
  const receipt = Array.from(crypto.getRandomValues(new Uint8Array(receiptBytes)), (byte) =>
    byte.toString(hexRadix).padStart(2, "0")
  ).join("");
  const digest = await receiptHash(receipt);
  const write = await db
    .prepare(`INSERT INTO hosted_delivery_proposals
    (turn_id, user_id, receipt_digest, proposed_at_ms, text)
    SELECT id, user_id, ?, ?, ? FROM hosted_turns
    WHERE id = ? AND user_id = ? AND status = 'pending'`)
    .bind(digest, transactionNow(), text, turnId, userId)
    .run();
  if (write.meta.changes !== 1) {
    throw new Error("Hosted Turn no longer pending");
  }
  return receipt;
};

const ProposalRow = Schema.Struct({
  text: TranscriptText,
  started_at_ms: Schema.Int,
});
/** Acknowledgment promotes only an exact staged provider reply with a fresh User-owned WebSession. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const acknowledgeHostedDelivery = async ({
  db,
  subject,
  turnId,
  receipt,
}: Readonly<{
  db: D1Database;
  subject: TransactionSubject;
  turnId: TranscriptTurnId;
  receipt: string;
}>): Promise<Option.Option<TranscriptText>> => {
  const current = transactionNow();
  const digest = await receiptHash(receipt);
  const raw = await db
    .prepare(`SELECT p.text, t.started_at_ms FROM hosted_delivery_proposals AS p
    JOIN hosted_turns AS t ON t.id = p.turn_id AND t.user_id = p.user_id
    JOIN web_sessions AS w ON w.user_id = p.user_id
    WHERE p.user_id = ? AND p.turn_id = ? AND p.receipt_digest = ?
      AND t.status = 'pending' AND w.id = ? AND w.token_digest = ?
      AND w.revoked_at_ms IS NULL AND w.idle_expires_at_ms > ? AND w.hard_expires_at_ms > ?`)
    .bind(subject.userId, turnId, digest, subject.id, subject.digest, current, current)
    .first();
  if (raw === null) {
    return Option.none();
  }
  const proposal = Schema.decodeUnknownSync(ProposalRow)(raw);
  const saved = await finishHostedTurn({
    db,
    userId: UserId.make(subject.userId),
    turnId,
    startedAtMs: proposal.started_at_ms,
    result: { _tag: "Completed", text: proposal.text },
    now: current,
  });
  return saved ? Option.some(proposal.text) : Option.none();
};

/** Terminal outcome whose evidence must be stored in the same D1 batch. */
export type HostedTurnOutcome =
  | Readonly<{ _tag: "Completed"; text: TranscriptText }>
  | Readonly<{ _tag: "Failed"; reason: TurnFailureReason }>
  | Readonly<{ _tag: "Interrupted" }>;
/** One terminal transition, with exact visible text or fixed metadata-only marker in the same batch. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const finishHostedTurn = async ({
  db,
  userId,
  turnId,
  startedAtMs,
  result,
  now,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  turnId: TranscriptTurnId;
  startedAtMs: number;
  result: HostedTurnOutcome;
  now: number;
}>): Promise<boolean> => {
  const time = Math.max(startedAtMs, now);
  const status = result._tag.toLowerCase();
  const reason = result._tag === "Failed" ? result.reason : null;
  const text = result._tag === "Completed" ? result.text : null;
  const kind = result._tag === "Completed" ? "assistant" : status;
  const entryId = TranscriptEntryId.make(newId());
  const results = await db.batch([
    db
      .prepare(`INSERT INTO transcript_entries
      (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, text, failure_reason)
      SELECT ?, user_id, hosted_session_id, id, ?, ?, ?, ? FROM hosted_turns
      WHERE id = ? AND user_id = ? AND status = 'pending'`)
      .bind(entryId, kind, time, text, reason, turnId, userId),
    db
      .prepare(`UPDATE hosted_turns SET status = ?, terminal_at_ms = ?, failure_reason = ?
      WHERE id = ? AND user_id = ? AND status = 'pending'`)
      .bind(status, time, reason, turnId, userId),
    db
      .prepare(`DELETE FROM hosted_delivery_proposals WHERE turn_id = ? AND user_id = ?`)
      .bind(turnId, userId),
    db
      .prepare(`UPDATE hosted_agent_sessions SET last_activity_at_ms = ? WHERE user_id = ?
      AND id = (SELECT hosted_session_id FROM hosted_turns WHERE id = ? AND user_id = ?)`)
      .bind(result._tag === "Interrupted" ? startedAtMs : time, userId, turnId, userId),
  ]);
  return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1;
};
