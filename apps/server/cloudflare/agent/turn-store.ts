import {
  AssistantTranscriptEntry,
  type CompactedConversationOutput,
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
  terminalPrefixCursor,
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
export const deliveryAcknowledgmentWindowMs = 120_000;
export const pendingExecutionRecoveryMs = 135_000;
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
const CompactRow = Schema.Struct({
  text: Schema.String.check(Schema.isMinLength(1)),
  through_sequence: Schema.Int,
  revision: Schema.Int,
});
const EntryRow = Schema.Struct({
  sequence: Schema.Int,
  status: Schema.Literals(["pending", "completed", "failed", "interrupted"]),
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

/** Read current Memories, CompactedConversation, and exact retained entries for one User and session. */
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
    compactedConversation: Option.Option<
      Readonly<{
        userId: UserId;
        sessionId: HostedAgentSessionId;
        text: string;
        throughSequence: number;
        revision: number;
      }>
    >;
    transcript: ReadonlyArray<SessionTranscriptEntry>;
    terminalThroughSequence: Option.Option<number>;
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
  const compactRaw = await db
    .prepare(`SELECT text, through_sequence, revision FROM hosted_compacted_conversations
    WHERE user_id = ? AND hosted_session_id = ? AND updated_at_ms >= ?`)
    .bind(subject.userId, sessionId, now - hostedTranscriptRetentionMs)
    .first();
  const compactedConversation = Option.map(
    Option.fromNullishOr(compactRaw),
    Schema.decodeUnknownSync(CompactRow)
  );
  const raw = await db
    .prepare(`SELECT e.sequence, e.id, e.turn_id, e.occurred_at_ms, e.kind, e.text,
      e.failure_reason, t.status FROM transcript_entries AS e
    JOIN hosted_turns AS t ON t.id = e.turn_id AND t.user_id = e.user_id
    WHERE e.user_id = ? AND e.hosted_session_id = ?
    ORDER BY sequence LIMIT ?`)
    .bind(subject.userId, sessionId, maximumRetainedEntries + 1)
    .all();
  if (raw.results.length > maximumRetainedEntries) {
    throw new Error("Hosted Transcript capacity exceeded");
  }
  const entries = Schema.decodeUnknownSync(Schema.Array(EntryRow))(raw.results);
  return {
    memories: memories.map(({ text }) => ({ text })),
    compactedConversation: Option.map(
      compactedConversation,
      ({ text, through_sequence, revision }) => ({
        userId: UserId.make(subject.userId),
        sessionId,
        text,
        throughSequence: through_sequence,
        revision,
      })
    ),
    terminalThroughSequence: terminalPrefixCursor(entries),
    transcript: entries.map((row) => ({
      userId: UserId.make(subject.userId),
      sessionId,
      sequence: BigInt(row.sequence),
      entry: decodeEntry(row),
    })),
  };
};

export type HostedContinuity = Awaited<ReturnType<typeof readHostedContinuity>>;

/** Charge one User-scoped pre-admission model attempt, including abandoned work. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const reserveHostedCompaction = async ({
  db,
  subject,
  sessionId,
}: Readonly<{
  db: D1Database;
  subject: TransactionSubject;
  sessionId: HostedAgentSessionId;
}>): Promise<boolean> => {
  const current = transactionNow();
  const authority = callerAuthority({ subject, current });
  const day = Math.floor(current / millisecondsPerDay) * millisecondsPerDay;
  const reserved = await db
    .prepare(`INSERT INTO hosted_compaction_attempts (user_id, day_ms, used)
    SELECT ?, ?, 1 WHERE EXISTS
      (SELECT 1 FROM hosted_agent_sessions WHERE user_id = ? AND id = ? AND status = 'active')
    AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})
    ON CONFLICT(user_id, day_ms) DO UPDATE SET used = used + 1
    WHERE hosted_compaction_attempts.used < 3`)
    .bind(subject.userId, day, subject.userId, sessionId, ...authority.bindings)
    .run();
  return reserved.meta.changes === 1;
};

/** Replace continuity only if the exact selected terminal prefix and prior revision still exist. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const commitHostedCompaction = async ({
  db,
  subject,
  sessionId,
  continuity,
  throughSequence,
  text,
  signal,
}: Readonly<{
  db: D1Database;
  subject: TransactionSubject;
  sessionId: HostedAgentSessionId;
  continuity: HostedContinuity;
  throughSequence: number;
  text: CompactedConversationOutput["compactedConversation"];
  signal: AbortSignal;
}>): Promise<boolean> => {
  const userId = UserId.make(subject.userId);
  const current = transactionNow();
  const authority = callerAuthority({ subject, current });
  const selected = continuity.transcript.filter(
    (entry) => entry.sequence <= BigInt(throughSequence)
  );
  if (
    selected.length === 0 ||
    !Option.exists(continuity.terminalThroughSequence, (cursor) => cursor === throughSequence)
  ) {
    return false;
  }
  const prior = Option.match(continuity.compactedConversation, {
    onNone: () => ({ throughSequence: 0, revision: 0 }),
    onSome: ({ throughSequence: cursor, revision }) => ({ throughSequence: cursor, revision }),
  });
  const nonce = newId();
  const nextRevision = prior.revision + 1;
  // There is no suspension between this check and dispatching the atomic batch. Once dispatched,
  // the replacement has entered its non-interruptible commit point; an abort cannot undo success.
  if (signal.aborted) return false;
  const results = await db.batch([
    db
      .prepare(`INSERT INTO hosted_compacted_conversations
      (user_id, hosted_session_id, text, through_sequence, revision, nonce, updated_at_ms)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS
        (SELECT 1 FROM hosted_agent_sessions WHERE user_id = ? AND id = ? AND status = 'active')
      AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})
      AND (SELECT COUNT(*) FROM transcript_entries WHERE user_id = ? AND hosted_session_id = ?
        AND sequence <= ?) = ?
      AND NOT EXISTS (SELECT 1 FROM transcript_entries AS e JOIN hosted_turns AS t
        ON t.id = e.turn_id AND t.user_id = e.user_id WHERE e.user_id = ?
        AND e.hosted_session_id = ? AND e.sequence <= ? AND t.status = 'pending')
      ON CONFLICT(user_id, hosted_session_id) DO UPDATE SET
        text = excluded.text, through_sequence = excluded.through_sequence,
        revision = excluded.revision, nonce = excluded.nonce, updated_at_ms = excluded.updated_at_ms
      WHERE hosted_compacted_conversations.revision = ?
        AND hosted_compacted_conversations.through_sequence = ?`)
      .bind(
        userId,
        sessionId,
        text,
        throughSequence,
        nextRevision,
        nonce,
        current,
        userId,
        sessionId,
        ...authority.bindings,
        userId,
        sessionId,
        throughSequence,
        selected.length,
        userId,
        sessionId,
        throughSequence,
        prior.revision,
        prior.throughSequence
      ),
    db
      .prepare(`DELETE FROM transcript_entries WHERE user_id = ? AND hosted_session_id = ?
      AND sequence <= ? AND EXISTS (SELECT 1 FROM hosted_compacted_conversations
        WHERE user_id = ? AND hosted_session_id = ? AND nonce = ? AND revision = ?)`)
      .bind(userId, sessionId, throughSequence, userId, sessionId, nonce, nextRevision),
  ]);
  return results[0]?.meta.changes === 1 && results[1]?.meta.changes === selected.length;
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
  proposed_at_ms: Schema.Int,
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
    .prepare(`SELECT p.text, p.proposed_at_ms, t.started_at_ms FROM hosted_delivery_proposals AS p
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
  if (current - proposal.proposed_at_ms >= deliveryAcknowledgmentWindowMs) {
    const recovered = await recoverHostedTurn({
      db,
      userId: UserId.make(subject.userId),
      turn: {
        id: turnId,
        started_at_ms: proposal.started_at_ms,
        proposed_at_ms: proposal.proposed_at_ms,
      },
      now: current,
    });
    if (!recovered) {
      throw new Error("Hosted receipt recovery was not committed");
    }
    return Option.none();
  }
  const saved = await finishHostedTurn({
    db,
    userId: UserId.make(subject.userId),
    turnId,
    startedAtMs: proposal.started_at_ms,
    result: { _tag: "Completed", text: proposal.text },
    subject,
    now: current,
  });
  return saved ? Option.some(proposal.text) : Option.none();
};

/** Retain exact Transcript content for at most thirty days after its terminal Turn. */
export const hostedTranscriptRetentionMs = 2_592_000_000;

// @effect-diagnostics-next-line asyncFunction:off
const sweepHostedTranscript = async (
  db: D1Database,
  userId: UserId,
  now: number
): Promise<Option.Option<number>> => {
  const cutoff = now - hostedTranscriptRetentionMs;
  await db
    .prepare(`DELETE FROM transcript_entries WHERE user_id = ? AND turn_id IN
    (SELECT id FROM hosted_turns WHERE user_id = ? AND status <> 'pending'
      AND terminal_at_ms < ?)`)
    .bind(userId, userId, cutoff)
    .run();
  await db
    .prepare(`DELETE FROM hosted_compacted_conversations
    WHERE user_id = ? AND updated_at_ms < ?`)
    .bind(userId, cutoff)
    .run();
  await db
    .prepare(`DELETE FROM hosted_compaction_attempts WHERE user_id = ? AND day_ms < ?`)
    .bind(userId, cutoff)
    .run();
  const compacted = await db
    .prepare(`SELECT MIN(updated_at_ms) AS oldest
    FROM hosted_compacted_conversations WHERE user_id = ?`)
    .bind(userId)
    .first();
  const compactedAge = Schema.decodeUnknownSync(
    Schema.Struct({ oldest: Schema.NullOr(Schema.Int) })
  )(compacted);
  const oldest = await db
    .prepare(`SELECT terminal_at_ms FROM hosted_turns AS t WHERE user_id = ?
      AND status <> 'pending' AND EXISTS
      (SELECT 1 FROM transcript_entries AS e WHERE e.turn_id = t.id AND e.user_id = t.user_id)
      ORDER BY terminal_at_ms LIMIT 1`)
    .bind(userId)
    .first<{ terminal_at_ms: number }>();
  const transcriptDue = Option.map(
    Option.fromNullishOr(oldest),
    (entry) => entry.terminal_at_ms + hostedTranscriptRetentionMs + 1
  );
  const compactDue = Option.map(
    Option.fromNullishOr(compactedAge.oldest),
    (updated) => updated + hostedTranscriptRetentionMs + 1
  );
  return Option.orElse(
    Option.map(compactDue, (due) =>
      Option.isSome(transcriptDue) ? Math.min(due, transcriptDue.value) : due
    ),
    () => transcriptDue
  );
};

/** DO alarm sweep: recover abandoned work and delete expired terminal content for this User. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const expireHostedPending = async ({
  db,
  userId,
  now,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  now: number;
}>): Promise<Option.Option<number>> => {
  const nextRetention = await sweepHostedTranscript(db, userId, now);
  const raw = await db
    .prepare(`SELECT id, started_at_ms,
    (SELECT proposed_at_ms FROM hosted_delivery_proposals WHERE turn_id = hosted_turns.id) AS proposed_at_ms
    FROM hosted_turns WHERE user_id = ? AND status = 'pending'`)
    .bind(userId)
    .first();
  if (raw === null) return nextRetention;
  const pending = Schema.decodeUnknownSync(TurnRow)(raw);
  const due =
    pending.proposed_at_ms === null
      ? pending.started_at_ms + pendingExecutionRecoveryMs
      : pending.proposed_at_ms + deliveryAcknowledgmentWindowMs;
  if (due > now) {
    return Option.some(Option.isSome(nextRetention) ? Math.min(due, nextRetention.value) : due);
  }
  const recovered = await recoverHostedTurn({ db, userId, turn: pending, now });
  if (!recovered) throw new Error("Hosted Turn alarm recovery was not committed");
  return Option.some(Option.getOrElse(nextRetention, () => now + hostedTranscriptRetentionMs));
};

/** Terminal outcome whose evidence must be stored in the same D1 batch. */
export type HostedTurnOutcome =
  | Readonly<{ _tag: "Completed"; text: TranscriptText }>
  | Readonly<{ _tag: "Failed"; reason: TurnFailureReason }>
  | Readonly<{ _tag: "Interrupted" }>;
type HostedFinishInput = Readonly<{
  db: D1Database;
  userId: UserId;
  turnId: TranscriptTurnId;
  startedAtMs: number;
  result: HostedTurnOutcome;
  subject: TransactionSubject;
  now: number;
}>;

const hostedFinishStatements = ({
  db,
  userId,
  turnId,
  startedAtMs,
  result,
  subject,
  now,
}: HostedFinishInput): Array<D1PreparedStatement> => {
  const time = Math.max(startedAtMs, now);
  const status = result._tag.toLowerCase();
  const reason = result._tag === "Failed" ? result.reason : null;
  const text = result._tag === "Completed" ? result.text : null;
  const kind = result._tag === "Completed" ? "assistant" : status;
  const entryId = TranscriptEntryId.make(newId());
  const sessionGuard = `AND (? <> 'completed' OR EXISTS (SELECT 1 FROM web_sessions AS w
    WHERE w.id = ? AND w.user_id = hosted_turns.user_id AND w.token_digest = ?
    AND w.revoked_at_ms IS NULL AND w.idle_expires_at_ms > ? AND w.hard_expires_at_ms > ?))`;
  return [
    db
      .prepare(`INSERT INTO transcript_entries
      (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, text, failure_reason)
      SELECT ?, user_id, hosted_session_id, id, ?, ?, ?, ? FROM hosted_turns
      WHERE id = ? AND user_id = ? AND status = 'pending' ${sessionGuard}`)
      .bind(
        entryId,
        kind,
        time,
        text,
        reason,
        turnId,
        userId,
        status,
        subject.id,
        subject.digest,
        time,
        time
      ),
    db
      .prepare(`UPDATE hosted_turns SET status = ?, terminal_at_ms = ?, failure_reason = ?
      WHERE id = ? AND user_id = ? AND status = 'pending' ${sessionGuard}`)
      .bind(status, time, reason, turnId, userId, status, subject.id, subject.digest, time, time),
    db
      .prepare(`DELETE FROM hosted_delivery_proposals WHERE turn_id = ? AND user_id = ?
      AND EXISTS (SELECT 1 FROM hosted_turns WHERE id = ? AND user_id = ? AND status <> 'pending')`)
      .bind(turnId, userId, turnId, userId),
    db
      .prepare(`UPDATE hosted_agent_sessions SET last_activity_at_ms = ? WHERE user_id = ?
      AND id = (SELECT hosted_session_id FROM hosted_turns WHERE id = ? AND user_id = ?
        AND status <> 'pending')`)
      .bind(result._tag === "Interrupted" ? startedAtMs : time, userId, turnId, userId),
  ];
};

/** One terminal transition, with exact visible text or fixed metadata-only marker in the same batch. */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const finishHostedTurn = async (input: HostedFinishInput): Promise<boolean> => {
  const results = await input.db.batch(hostedFinishStatements(input));
  return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1;
};
