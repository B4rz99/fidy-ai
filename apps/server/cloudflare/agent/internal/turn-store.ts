import { loadsSavedHistory } from "./history-allowance";
import { prepareConsumption, quotaFailure } from "../../quotas/operations";
import { allowancePeriod } from "../../../src/core/quotas/operations";
import { readMemoryContext } from "../../memory/operations";
import {
  AssistantTranscriptEntry,
  CanonicalToolCallEntry,
  CanonicalToolEvidence,
  CanonicalToolOutcome,
  CanonicalToolResultEntry,
  type CompactedConversationOutput,
  FailedTurnTranscriptEntry,
  type HostedAdmissionState,
  HostedAgentSessionConsentBasis,
  HostedAgentSessionId,
  TranscriptEntry,
  TranscriptEntryId,
  TranscriptText,
  TranscriptTurnId,
  TurnFailureReason,
  UserTranscriptEntry,
} from "../../../src/core/agent/contract";
import { type SessionTranscriptEntry } from "./working-context";
import { type UserContext, UserId } from "../../../src/core/identity/contract";
import { decideHostedAdmission, terminalPrefixCursor } from "../../../src/core/agent/operations";

import { webSessionCredentialAuthority } from "../../../src/shell/web-session/operations";
import { Cause, DateTime, Effect, Option, Schema } from "effect";
import type { OwnedStatement } from "../../../src/shell/owner-write/contract";
import { type TransactionSubject, transactionNow } from "../../canonical-work/operations";
import { readConsentStanding } from "../../consent/operations";
import { readUserContext } from "../../identity/user-context/operations";
import { newId } from "../../secret-material/operations";
import {
  type WhatsAppHostedSubject,
  type WhatsAppInboundEvidence,
  type WhatsAppUnavailable,
} from "../../whatsapp/contract";
import {
  expireWhatsAppEvidence,
  prepareWhatsAppInbound,
  prepareWhatsAppWorkCleanup,
  recoverWhatsAppDelivery,
  whatsAppCompletionGuard,
  whatsAppInterruptionGuard,
  whatsAppProposalTimes,
} from "../../whatsapp/operations";
import {
  deliveryAcknowledgmentWindowMs,
  hostedTranscriptRetentionMs,
  pendingExecutionRecoveryMs,
} from "../contract";
import {
  type HostedSubject,
  hostedAuthority,
  hostedIdentity,
  isWhatsAppHosted,
} from "./hosted-authority";

const maximumRetainedEntries = 200;
const maximumCurrentMemories = 100;
const millisecondsPerDay = 86_400_000;
const maximumDailyTurns = 50;
const receiptBytes = 32;
const hexRadix = 16;
export { deliveryAcknowledgmentWindowMs } from "../contract";

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
  kind: Schema.Literals(["user", "assistant", "tool_call", "tool_result", "failed", "interrupted"]),
  text: Schema.NullOr(Schema.String),
  failure_reason: Schema.NullOr(TurnFailureReason),
  iteration: Schema.NullOr(Schema.Int),
  tool_call_id: Schema.NullOr(Schema.String),
  operation: Schema.NullOr(Schema.String),
  input_json: Schema.NullOr(Schema.String),
  outcome_json: Schema.NullOr(Schema.String),
});

type SessionRow = typeof SessionRow.Type;
type TurnRow = typeof TurnRow.Type;
type EntryRow = typeof EntryRow.Type;

/** A live credential selects its own User; retained Consent standing distinguishes refusal. */
export type HostedTurnSnapshot = Readonly<{
  user: UserContext;
  consentBasis: HostedAgentSessionConsentBasis;
  revoked: boolean;
  capacityAvailable: boolean;
  session: Option.Option<SessionRow>;
  pending: Option.Option<TurnRow>;
}>;

/** Recheck the supplied WebSession or verified WhatsApp association and read the User's hosted lifecycle; revoked Consent remains visible for refusal. */
export const readHostedSnapshot = ({
  db,
  subject,
  now,
}: Readonly<{
  db: D1Database;
  subject: HostedSubject;
  now: number;
}>): Effect.Effect<
  Option.Option<HostedTurnSnapshot>,
  Cause.UnknownError | Schema.SchemaError | WhatsAppUnavailable
> =>
  Effect.gen(function* () {
    const authority = hostedIdentity({ subject, current: now });
    const userId = yield* Schema.decodeEffect(UserId)(subject.userId);
    const user = yield* readUserContext({
      db,
      userId,
      authority: Option.some(authority),
    }).pipe(Effect.mapError((cause) => new Cause.UnknownError(cause)));
    if (Option.isNone(user)) return Option.none();
    const standing = yield* readConsentStanding({ db, userId: subject.userId }).pipe(
      Effect.mapError((cause) => new Cause.UnknownError(cause))
    );
    if (standing._tag === "Missing") return Option.none();
    const sessionRaw = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT id, user_id, consent_basis_json, started_at_ms, last_activity_at_ms, status
      FROM hosted_agent_sessions WHERE user_id = ?
      ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, started_at_ms DESC, id DESC LIMIT 1`)
        .bind(subject.userId)
        .first()
    );
    const channelProposals = whatsAppProposalTimes(userId);
    const pendingRaw = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT id, started_at_ms,
      COALESCE(
        (SELECT proposed_at_ms FROM hosted_delivery_proposals WHERE turn_id = hosted_turns.id),
        (SELECT proposedAtMs FROM (${channelProposals.sql}) WHERE turnId = hosted_turns.id)
      ) AS proposed_at_ms
      FROM hosted_turns WHERE user_id = ? AND status = 'pending'`)
        .bind(...channelProposals.params, subject.userId)
        .first()
    );
    const day = Math.floor(now / millisecondsPerDay) * millisecondsPerDay;
    const budget = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT COUNT(*) AS used FROM hosted_turns
    WHERE user_id = ? AND started_at_ms >= ? AND started_at_ms < ?`)
        .bind(subject.userId, day, day + millisecondsPerDay)
        .first()
    );
    const budgetRow = Option.flatMap(
      Option.fromNullishOr(budget),
      Schema.decodeUnknownOption(Schema.Struct({ used: Schema.Int }))
    );
    return Option.some({
      user: user.value,
      consentBasis: standing.basis,
      revoked: standing._tag === "Revoked",
      capacityAvailable: Option.exists(budgetRow, (row) => row.used < maximumDailyTurns),
      session:
        sessionRaw === null
          ? Option.none()
          : Option.some(yield* Schema.decodeUnknownEffect(SessionRow)(sessionRaw)),
      pending:
        pendingRaw === null
          ? Option.none()
          : Option.some(yield* Schema.decodeUnknownEffect(TurnRow)(pendingRaw)),
    });
  });

/** Recovery works even after revocation: it never admits new work or sends User content. */
export const recoverHostedTurn = ({
  db,
  userId,
  turn,
  now,
}: Readonly<{ db: D1Database; userId: UserId; turn: TurnRow; now: number }>): Effect.Effect<
  boolean,
  Cause.UnknownError | Schema.SchemaError | WhatsAppUnavailable
> =>
  Effect.gen(function* () {
    const channel = yield* recoverWhatsAppDelivery({
      db,
      userId,
      turnId: turn.id,
      startedAtMs: turn.started_at_ms,
      now,
    });
    if (Option.isSome(channel)) return yield* finishHostedTurn({ db, ...channel.value });
    const timestamp = Math.max(now, turn.started_at_ms);
    const marker = TranscriptEntryId.make(newId());
    const results = yield* Effect.tryPromise(() =>
      db.batch([
        // A committed owner write and its receipt are atomic. If its response was lost, record
        // the commit without inventing the unavailable canonical output before interrupting.
        db
          .prepare(`INSERT INTO transcript_entries
      (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, iteration,
       tool_call_id, operation, outcome_json)
      SELECT lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' ||
        lower(substr(hex(randomblob(2)), 2, 3)) || '-8' ||
        lower(substr(hex(randomblob(2)), 2, 3)) || '-' || lower(hex(randomblob(6))),
        c.user_id, c.hosted_session_id, c.turn_id, 'tool_result', ?, c.iteration,
        c.tool_call_id, c.operation,
        '{"_tag":"CommittedOutputUnavailable"}'
      FROM transcript_entries AS c
      JOIN hosted_mutation_commits AS m
        ON m.turn_id = c.turn_id AND m.tool_call_id = c.tool_call_id AND m.user_id = c.user_id
      WHERE c.turn_id = ? AND c.user_id = ? AND c.kind = 'tool_call'
        AND NOT EXISTS (SELECT 1 FROM transcript_entries AS r
          WHERE r.turn_id = c.turn_id AND r.tool_call_id = c.tool_call_id AND r.kind = 'tool_result')`)
          .bind(timestamp, turn.id, userId),
        db
          .prepare(`INSERT INTO transcript_entries
      (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms)
      SELECT ?, user_id, hosted_session_id, id, 'interrupted', ? FROM hosted_turns
      WHERE id = ? AND user_id = ? AND status = 'pending'
        ${whatsAppInterruptionGuard()}`)
          .bind(marker, timestamp, turn.id, userId),
        db
          .prepare(`UPDATE hosted_turns SET status = 'interrupted', terminal_at_ms = ?
      WHERE id = ? AND user_id = ? AND status = 'pending'
        ${whatsAppInterruptionGuard()}`)
          .bind(timestamp, turn.id, userId),
        db
          .prepare(`DELETE FROM hosted_delivery_proposals WHERE turn_id = ? AND user_id = ?`)
          .bind(turn.id, userId),
        prepareWhatsAppWorkCleanup({ db, turnId: turn.id, userId, requireTerminal: false }),
        // A recovered Pending Turn's activity was its start, not this recovery instant.
        db
          .prepare(`UPDATE hosted_agent_sessions SET last_activity_at_ms = ? WHERE user_id = ?
      AND id = (SELECT hosted_session_id FROM hosted_turns WHERE id = ? AND user_id = ?)`)
          .bind(turn.started_at_ms, userId, turn.id, userId),
      ])
    );
    return results[1]?.meta.changes === 1 && results[2]?.meta.changes === 1;
  });

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
export const selectHostedSession = ({
  snapshot,
  userId,
  now,
}: Readonly<{
  snapshot: HostedTurnSnapshot;
  userId: UserId;
  now: number;
}>): Readonly<{
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

/** Read retained continuity; an admitted WhatsApp Turn keeps its admission-time Consent basis through revocation, while new work requires current Consent. */
export const readHostedContinuity = ({
  db,
  subject,
  sessionId,
  now,
  admittedWhatsAppTurn,
}: Readonly<{
  db: D1Database;
  subject: HostedSubject;
  sessionId: HostedAgentSessionId;
  now: number;
  admittedWhatsAppTurn: Option.Option<TranscriptTurnId>;
}>): Effect.Effect<
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
  }>,
  Cause.UnknownError | Schema.SchemaError | WhatsAppUnavailable
> =>
  Effect.gen(function* () {
    // Explicit revocation forbids the next admission, not continuity of an admitted Turn.
    const authority =
      Option.isSome(admittedWhatsAppTurn) && isWhatsAppHosted(subject)
        ? hostedIdentity({ subject, current: now })
        : hostedAuthority({ subject, current: now });
    const memories = Option.getOrThrow(
      yield* readMemoryContext({ db, userId: subject.userId, authority })
    );
    if (memories.length > maximumCurrentMemories) {
      throw new Error("Hosted Memory capacity exceeded");
    }
    const compactRaw = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT text, through_sequence, revision FROM hosted_compacted_conversations
    WHERE user_id = ? AND hosted_session_id = ? AND updated_at_ms >= ?`)
        .bind(subject.userId, sessionId, now - hostedTranscriptRetentionMs)
        .first()
    );
    const compactedConversation =
      compactRaw === null
        ? Option.none()
        : Option.some(yield* Schema.decodeUnknownEffect(CompactRow)(compactRaw));
    const raw = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT e.sequence, e.id, e.turn_id, e.occurred_at_ms, e.kind, e.text,
      e.failure_reason, e.iteration, e.tool_call_id, e.operation, e.input_json,
      e.outcome_json, t.status FROM transcript_entries AS e
    JOIN hosted_turns AS t ON t.id = e.turn_id AND t.user_id = e.user_id
    WHERE e.user_id = ? AND e.hosted_session_id = ?
    ORDER BY sequence LIMIT ?`)
        .bind(subject.userId, sessionId, maximumRetainedEntries + 1)
        .all()
    );
    if (raw.results.length > maximumRetainedEntries) {
      throw new Error("Hosted Transcript capacity exceeded");
    }
    const entries = yield* Schema.decodeUnknownEffect(Schema.Array(EntryRow))(raw.results);
    return {
      memories,
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
  });

export type HostedContinuity = Effect.Success<ReturnType<typeof readHostedContinuity>>;

/** Append one decoded tool entry only while its User's Turn remains Pending. */
type HostedToolEntry = CanonicalToolCallEntry | CanonicalToolResultEntry;
type ToolPublication = Readonly<{
  db: D1Database;
  userId: UserId;
  subject: HostedSubject;
  entry: HostedToolEntry;
}>;
const prepareToolEntry = ({
  db,
  userId,
  entry,
  authority,
  inputJson,
  outcomeJson,
}: ToolPublication &
  Readonly<{
    authority: OwnedStatement;
    inputJson: Option.Option<string>;
    outcomeJson: Option.Option<string>;
  }>): D1PreparedStatement =>
  db
    .prepare(`INSERT INTO transcript_entries
  (id,user_id,hosted_session_id,turn_id,kind,occurred_at_ms,iteration,tool_call_id,operation,input_json,outcome_json)
  SELECT ?,user_id,hosted_session_id,id,?,?,?,?,?,?,? FROM hosted_turns
  WHERE id = ? AND user_id = ? AND status = 'pending' AND EXISTS (${authority.sql})`)
    .bind(
      entry.id,
      entry._tag === "CanonicalToolCallEntry" ? "tool_call" : "tool_result",
      entry.occurredAt.epochMilliseconds,
      entry.iteration,
      entry.toolCallId,
      entry.operation,
      Option.getOrNull(inputJson),
      Option.getOrNull(outcomeJson),
      entry.turnId,
      userId,
      ...authority.params
    );
const writeToolEntry = (
  input: ToolPublication,
  participants: ReadonlyArray<D1PreparedStatement>
): Effect.Effect<Option.Option<HostedToolEntry>, Cause.UnknownError | Schema.SchemaError> =>
  Effect.gen(function* () {
    const entry = input.entry;
    const inputJson =
      entry._tag === "CanonicalToolCallEntry"
        ? Option.some(
            yield* Schema.encodeEffect(Schema.fromJsonString(CanonicalToolEvidence))(entry.input)
          )
        : Option.none<string>();
    const outcomeJson =
      entry._tag === "CanonicalToolResultEntry"
        ? Option.some(
            yield* Schema.encodeEffect(Schema.fromJsonString(CanonicalToolOutcome))(entry.outcome)
          )
        : Option.none<string>();
    const authority = hostedAuthority({ subject: input.subject, current: transactionNow() });
    const statement = prepareToolEntry({ ...input, authority, inputJson, outcomeJson });
    const changed =
      participants.length === 0
        ? yield* Effect.tryPromise(() => statement.run()).pipe(
            Effect.map((result) => result.meta.changes)
          )
        : yield* Effect.tryPromise(() => input.db.batch([...participants, statement])).pipe(
            Effect.map((results) => results[results.length - 1]?.meta.changes)
          );
    return changed === 1 ? Option.some(entry) : Option.none();
  });

/** Publish successful new history and its one User+Turn unit atomically, before exposing any rows to inference. */
export const appendHostedToolEntry = (
  input: ToolPublication
): Effect.Effect<
  Option.Option<HostedToolEntry>,
  Cause.UnknownError | Schema.SchemaError | WhatsAppUnavailable
> =>
  Effect.gen(function* () {
    const { db, userId, subject, entry } = input;
    if (entry._tag !== "CanonicalToolResultEntry" || !loadsSavedHistory(entry)) {
      return yield* writeToolEntry(input, []);
    }
    const current = transactionNow();
    const live = hostedAuthority({ subject, current });
    const authority = {
      sql: `SELECT user_id AS userId FROM hosted_turns WHERE id = ? AND user_id = ? AND status = 'pending' AND EXISTS (${live.sql})`,
      params: [entry.turnId, userId, ...live.params],
    };
    const published = yield* writeToolEntry(
      input,
      prepareConsumption({
        db,
        userId,
        allowance: "hosted_history_turn",
        identity: entry.turnId,
        current,
        authority,
      })
    ).pipe(Effect.result);
    if (published._tag === "Success") return published.success;
    if (quotaFailure(published.failure.cause) !== "exhausted") return yield* published.failure;
    const rejected: CanonicalToolResultEntry = {
      ...entry,
      outcome: {
        _tag: "CanonicalOperationFailed",
        failure: {
          error: {
            code: "quota_exhausted",
            allowance: "hosted_history_turn",
            resetsAt: DateTime.formatIso(allowancePeriod(DateTime.makeUnsafe(current)).resetsAt),
          },
          next: [],
        },
      },
    };
    return yield* writeToolEntry({ ...input, entry: rejected }, []);
  });

/** Charge one User-scoped pre-admission model attempt, including abandoned work. */
export const reserveHostedCompaction = ({
  db,
  subject,
  sessionId,
}: Readonly<{
  db: D1Database;
  subject: HostedSubject;
  sessionId: HostedAgentSessionId;
}>): Effect.Effect<boolean, Cause.UnknownError | Schema.SchemaError | WhatsAppUnavailable> =>
  Effect.gen(function* () {
    const current = transactionNow();
    const authority = hostedAuthority({ subject, current });
    const day = Math.floor(current / millisecondsPerDay) * millisecondsPerDay;
    const reserved = yield* Effect.tryPromise(() =>
      db
        .prepare(`INSERT INTO hosted_compaction_attempts (user_id, day_ms, used)
    SELECT ?, ?, 1 WHERE EXISTS
      (SELECT 1 FROM hosted_agent_sessions WHERE user_id = ? AND id = ? AND status = 'active')
    AND EXISTS (${authority.sql})
    ON CONFLICT(user_id, day_ms) DO UPDATE SET used = used + 1
    WHERE hosted_compaction_attempts.used < 3`)
        .bind(subject.userId, day, subject.userId, sessionId, ...authority.params)
        .run()
    );
    return reserved.meta.changes === 1;
  });

/** Replace continuity only if the exact selected terminal prefix and prior revision still exist. */
export const commitHostedCompaction = ({
  db,
  subject,
  sessionId,
  continuity,
  throughSequence,
  text,
  signal,
}: Readonly<{
  db: D1Database;
  subject: HostedSubject;
  sessionId: HostedAgentSessionId;
  continuity: HostedContinuity;
  throughSequence: number;
  text: CompactedConversationOutput["compactedConversation"];
  signal: AbortSignal;
}>): Effect.Effect<boolean, Cause.UnknownError | Schema.SchemaError | WhatsAppUnavailable> =>
  Effect.gen(function* () {
    const userId = UserId.make(subject.userId);
    const current = transactionNow();
    const authority = hostedAuthority({ subject, current });
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
    const results = yield* Effect.tryPromise(() =>
      db.batch([
        db
          .prepare(`INSERT INTO hosted_compacted_conversations
      (user_id, hosted_session_id, text, through_sequence, revision, nonce, updated_at_ms)
      SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS
        (SELECT 1 FROM hosted_agent_sessions WHERE user_id = ? AND id = ? AND status = 'active')
      AND EXISTS (${authority.sql})
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
            ...authority.params,
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
      ])
    );
    return results[0]?.meta.changes === 1 && results[1]?.meta.changes === selected.length;
  });

const decodeToolEntry = (
  row: EntryRow,
  identity: Readonly<{ id: TranscriptEntryId; turnId: TranscriptTurnId; occurredAt: string }>
): CanonicalToolCallEntry | CanonicalToolResultEntry => {
  if (row.kind === "tool_call") {
    return Schema.decodeUnknownSync(CanonicalToolCallEntry)({
      _tag: "CanonicalToolCallEntry",
      ...identity,
      iteration: row.iteration,
      toolCallId: row.tool_call_id,
      operation: row.operation,
      input: Schema.decodeUnknownSync(Schema.fromJsonString(CanonicalToolEvidence))(row.input_json),
    });
  }
  return Schema.decodeUnknownSync(CanonicalToolResultEntry)({
    _tag: "CanonicalToolResultEntry",
    ...identity,
    iteration: row.iteration,
    toolCallId: row.tool_call_id,
    operation: row.operation,
    outcome: Schema.decodeUnknownSync(Schema.fromJsonString(CanonicalToolOutcome))(
      row.outcome_json
    ),
  });
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
    case "tool_call":
    case "tool_result":
      return decodeToolEntry(row, identity);
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

export type HostedAdmissionChannel =
  | Readonly<{ _tag: "Browser"; subject: TransactionSubject }>
  | Readonly<{
      _tag: "WhatsApp";
      subject: WhatsAppHostedSubject;
      inbound: WhatsAppInboundEvidence;
    }>;

const prepareChannelAdmission = ({
  db,
  channel,
  id,
  now,
}: Readonly<{
  db: D1Database;
  channel: HostedAdmissionChannel;
  id: TranscriptTurnId;
  now: number;
}>): ReadonlyArray<D1PreparedStatement> =>
  channel._tag === "WhatsApp"
    ? prepareWhatsAppInbound({ db, subject: channel.subject, inbound: channel.inbound, id, now })
    : [];

/** Append the exact User entry and Pending Turn atomically after the complete model preflight. */
export const admitHostedTurn = ({
  db,
  channel,
  selection,
  text,
  now,
  id,
}: Readonly<{
  db: D1Database;
  channel: HostedAdmissionChannel;
  selection: ReturnType<typeof selectHostedSession>;
  text: TranscriptText;
  now: number;
  id: TranscriptTurnId;
}>): Effect.Effect<
  Option.Option<TranscriptTurnId>,
  Cause.UnknownError | Schema.SchemaError | WhatsAppUnavailable
> =>
  Effect.gen(function* () {
    const subject = channel.subject;
    const entryId = TranscriptEntryId.make(newId());
    const authority = hostedAuthority({ subject, current: now });
    const basisJson = yield* Schema.encodeEffect(
      Schema.fromJsonString(HostedAgentSessionConsentBasis)
    )(selection.basis);
    const createSession = selection.create
      ? db
          .prepare(`INSERT INTO hosted_agent_sessions
        (id, user_id, consent_basis_json, started_at_ms, status)
        SELECT ?, userId, ?, ?, 'active' FROM (${authority.sql})`)
          .bind(selection.id, basisJson, now, ...authority.params)
      : db
          .prepare(
            `UPDATE hosted_agent_sessions SET status = 'active' WHERE id = ? AND user_id = ? AND status = 'active'`
          )
          .bind(selection.id, subject.userId);
    const channelStatements = prepareChannelAdmission({ db, channel, id, now });
    const results = yield* Effect.tryPromise(() =>
      db.batch([
        createSession,
        db
          .prepare(`INSERT INTO hosted_turns (id, user_id, hosted_session_id, started_at_ms, status)
      SELECT ?, userId, ?, ?, 'pending' FROM (${authority.sql})`)
          .bind(id, selection.id, now, ...authority.params),
        db
          .prepare(`INSERT INTO transcript_entries
      (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, text)
      SELECT ?, user_id, hosted_session_id, id, 'user', ?, ? FROM hosted_turns
      WHERE id = ? AND user_id = ? AND status = 'pending'`)
          .bind(entryId, now, text, id, subject.userId),
        ...channelStatements,
        db
          .prepare(`UPDATE hosted_agent_sessions SET status = 'idle-ended'
      WHERE user_id = ? AND id <> ? AND status = 'active'`)
          .bind(subject.userId, selection.id),
      ])
    );
    return results[0]?.meta.changes === 1 &&
      results[1]?.meta.changes === 1 &&
      results[2]?.meta.changes === 1
      ? Option.some(id)
      : Option.none();
  });

const receiptHash = (
  receipt: string
): Effect.Effect<Uint8Array, Cause.UnknownError | Schema.SchemaError | WhatsAppUnavailable> =>
  Effect.tryPromise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(receipt))).pipe(
    Effect.map((value) => new Uint8Array(value))
  );

/** Reserve one exact provider answer; this is not yet Transcript evidence. */
export const stageHostedDelivery = ({
  db,
  userId,
  turnId,
  text,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  turnId: TranscriptTurnId;
  text: TranscriptText;
}>): Effect.Effect<string, Cause.UnknownError | Schema.SchemaError | WhatsAppUnavailable> =>
  Effect.gen(function* () {
    const receipt = Array.from(crypto.getRandomValues(new Uint8Array(receiptBytes)), (byte) =>
      byte.toString(hexRadix).padStart(2, "0")
    ).join("");
    const digest = yield* receiptHash(receipt);
    const write = yield* Effect.tryPromise(() =>
      db
        .prepare(`INSERT INTO hosted_delivery_proposals
    (turn_id, user_id, receipt_digest, proposed_at_ms, text)
    SELECT id, user_id, ?, ?, ? FROM hosted_turns
    WHERE id = ? AND user_id = ? AND status = 'pending'`)
        .bind(digest, transactionNow(), text, turnId, userId)
        .run()
    );
    if (write.meta.changes !== 1) {
      throw new Error("Hosted Turn no longer pending");
    }
    return receipt;
  });

/** Reissue only the receipt for a pending answer; never replay a bearer credential from storage. */
export const refreshHostedDelivery = ({
  db,
  subject,
  turnId,
}: Readonly<{
  db: D1Database;
  subject: TransactionSubject;
  turnId: TranscriptTurnId;
}>): Effect.Effect<
  Option.Option<Readonly<{ text: TranscriptText; receipt: string }>>,
  Cause.UnknownError | Schema.SchemaError | WhatsAppUnavailable
> =>
  Effect.gen(function* () {
    const snapshot = yield* readHostedSnapshot({ db, subject, now: transactionNow() });
    if (
      Option.isNone(snapshot) ||
      !Option.exists(snapshot.value.pending, (pending) => pending.id === turnId)
    ) {
      return Option.none();
    }
    const row = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT text FROM hosted_delivery_proposals
    WHERE turn_id = ? AND user_id = ?`)
        .bind(turnId, subject.userId)
        .first()
    );
    if (row === null) return Option.none();
    const text = (yield* Schema.decodeUnknownEffect(Schema.Struct({ text: TranscriptText }))(row))
      .text;
    const receipt = Array.from(crypto.getRandomValues(new Uint8Array(receiptBytes)), (byte) =>
      byte.toString(hexRadix).padStart(2, "0")
    ).join("");
    const digest = yield* receiptHash(receipt);
    const written = yield* Effect.tryPromise(() =>
      db
        .prepare(`UPDATE hosted_delivery_proposals
    SET receipt_digest = ?
    WHERE turn_id = ? AND user_id = ? AND proposed_at_ms > ? AND EXISTS
      (SELECT 1 FROM hosted_turns WHERE id = ? AND user_id = ? AND status = 'pending')`)
        .bind(
          digest,
          turnId,
          subject.userId,
          transactionNow() - deliveryAcknowledgmentWindowMs,
          turnId,
          subject.userId
        )
        .run()
    );
    return written.meta.changes === 1 ? Option.some({ text, receipt }) : Option.none();
  });

const ProposalRow = Schema.Struct({
  text: TranscriptText,
  started_at_ms: Schema.Int,
  proposed_at_ms: Schema.Int,
});
/** Acknowledgment promotes only an exact staged provider reply with a fresh User-owned WebSession. */
export const acknowledgeHostedDelivery = ({
  db,
  subject,
  turnId,
  receipt,
}: Readonly<{
  db: D1Database;
  subject: TransactionSubject;
  turnId: TranscriptTurnId;
  receipt: string;
}>): Effect.Effect<
  Option.Option<TranscriptText>,
  Cause.UnknownError | Schema.SchemaError | WhatsAppUnavailable
> =>
  Effect.gen(function* () {
    const current = transactionNow();
    const digest = yield* receiptHash(receipt);
    const authority = webSessionCredentialAuthority({ subject, current });
    const raw = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT p.text, p.proposed_at_ms, t.started_at_ms FROM hosted_delivery_proposals AS p
    JOIN hosted_turns AS t ON t.id = p.turn_id AND t.user_id = p.user_id
    WHERE p.user_id = ? AND p.turn_id = ? AND p.receipt_digest = ?
      AND t.status = 'pending' AND EXISTS (SELECT 1 FROM ${authority.table} WHERE ${authority.predicate})`)
        .bind(subject.userId, turnId, digest, ...authority.bindings)
        .first()
    );
    if (raw === null) {
      return Option.none();
    }
    const proposal = yield* Schema.decodeUnknownEffect(ProposalRow)(raw);
    if (current - proposal.proposed_at_ms >= deliveryAcknowledgmentWindowMs) {
      const recovered = yield* recoverHostedTurn({
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
    const saved = yield* finishHostedTurn({
      db,
      userId: UserId.make(subject.userId),
      turnId,
      startedAtMs: proposal.started_at_ms,
      result: { _tag: "Completed", text: proposal.text },
      subject,
      now: current,
    });
    return saved ? Option.some(proposal.text) : Option.none();
  });

/** Retain exact Transcript content for at most thirty days after its terminal Turn. */
export { hostedTranscriptRetentionMs } from "../contract";

const sweepHostedTranscript = (
  db: D1Database,
  userId: UserId,
  now: number
): Effect.Effect<
  Option.Option<number>,
  Cause.UnknownError | Schema.SchemaError | WhatsAppUnavailable
> =>
  Effect.gen(function* () {
    const cutoff = now - hostedTranscriptRetentionMs;
    yield* Effect.tryPromise(() =>
      db
        .prepare("DELETE FROM hosted_confirmations WHERE user_id = ? AND expires_at_ms < ?")
        .bind(userId, now)
        .run()
    );
    yield* Effect.tryPromise(() =>
      db
        .prepare(`DELETE FROM hosted_mutation_commits WHERE user_id = ? AND turn_id IN
    (SELECT id FROM hosted_turns WHERE user_id = ? AND status <> 'pending'
      AND terminal_at_ms < ?)`)
        .bind(userId, userId, cutoff)
        .run()
    );
    yield* expireWhatsAppEvidence({ db, userId, now });
    yield* Effect.tryPromise(() =>
      db
        .prepare(`DELETE FROM transcript_entries WHERE user_id = ? AND turn_id IN
    (SELECT id FROM hosted_turns WHERE user_id = ? AND status <> 'pending'
      AND terminal_at_ms < ?)`)
        .bind(userId, userId, cutoff)
        .run()
    );
    yield* Effect.tryPromise(() =>
      db
        .prepare(`DELETE FROM hosted_compacted_conversations
    WHERE user_id = ? AND updated_at_ms < ?`)
        .bind(userId, cutoff)
        .run()
    );
    yield* Effect.tryPromise(() =>
      db
        .prepare(`DELETE FROM hosted_compaction_attempts WHERE user_id = ? AND day_ms < ?`)
        .bind(userId, cutoff)
        .run()
    );
    return yield* readHostedRetentionDeadline(db, userId);
  });

// Read remaining evidence deadlines after expiry deletes commit; Pending Turn recovery is separate.
const readHostedRetentionDeadline = (
  db: D1Database,
  userId: UserId
): Effect.Effect<
  Option.Option<number>,
  Cause.UnknownError | Schema.SchemaError | WhatsAppUnavailable
> =>
  Effect.gen(function* () {
    const compacted = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT MIN(updated_at_ms) AS oldest
    FROM hosted_compacted_conversations WHERE user_id = ?`)
        .bind(userId)
        .first()
    );
    const compactedAge = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ oldest: Schema.NullOr(Schema.Int) })
    )(compacted);
    const oldest = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT terminal_at_ms FROM hosted_turns AS t WHERE user_id = ?
      AND status <> 'pending' AND EXISTS
      (SELECT 1 FROM transcript_entries AS e WHERE e.turn_id = t.id AND e.user_id = t.user_id)
      ORDER BY terminal_at_ms LIMIT 1`)
        .bind(userId)
        .first()
    );
    const oldestEntry =
      oldest === null
        ? Option.none()
        : Option.some(
            yield* Schema.decodeUnknownEffect(Schema.Struct({ terminal_at_ms: Schema.Int }))(oldest)
          );
    const transcriptDue = Option.map(
      oldestEntry,
      (entry) => entry.terminal_at_ms + hostedTranscriptRetentionMs + 1
    );
    const compactDue = Option.map(
      Option.fromNullishOr(compactedAge.oldest),
      (updated) => updated + hostedTranscriptRetentionMs + 1
    );
    const confirmation = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT MIN(expires_at_ms) AS oldest
    FROM hosted_confirmations WHERE user_id = ?`)
        .bind(userId)
        .first()
    );
    const confirmationAge = yield* Schema.decodeUnknownEffect(
      Schema.Struct({ oldest: Schema.NullOr(Schema.Int) })
    )(confirmation);
    const confirmationDue = Option.map(
      Option.fromNullishOr(confirmationAge.oldest),
      (at) => at + 1
    );
    const due = [transcriptDue, compactDue, confirmationDue]
      .filter(Option.isSome)
      .map((candidate) => candidate.value);
    return due.length === 0 ? Option.none() : Option.some(Math.min(...due));
  });

/** DO alarm sweep: recover abandoned work and delete expired terminal content for this User. */
export const expireHostedPending = ({
  db,
  userId,
  now,
}: Readonly<{
  db: D1Database;
  userId: UserId;
  now: number;
}>): Effect.Effect<
  Option.Option<number>,
  Cause.UnknownError | Schema.SchemaError | WhatsAppUnavailable
> =>
  Effect.gen(function* () {
    const nextRetention = yield* sweepHostedTranscript(db, userId, now);
    const channelProposals = whatsAppProposalTimes(userId);
    const raw = yield* Effect.tryPromise(() =>
      db
        .prepare(`SELECT id, started_at_ms,
    COALESCE(
      (SELECT proposed_at_ms FROM hosted_delivery_proposals WHERE turn_id = hosted_turns.id),
      (SELECT proposedAtMs FROM (${channelProposals.sql}) WHERE turnId = hosted_turns.id)
    ) AS proposed_at_ms
    FROM hosted_turns WHERE user_id = ? AND status = 'pending'`)
        .bind(...channelProposals.params, userId)
        .first()
    );
    if (raw === null) return nextRetention;
    const pending = yield* Schema.decodeUnknownEffect(TurnRow)(raw);
    const due =
      pending.proposed_at_ms === null
        ? pending.started_at_ms + pendingExecutionRecoveryMs
        : pending.proposed_at_ms + deliveryAcknowledgmentWindowMs;
    if (due > now) {
      return Option.some(Option.isSome(nextRetention) ? Math.min(due, nextRetention.value) : due);
    }
    const recovered = yield* recoverHostedTurn({ db, userId, turn: pending, now });
    if (!recovered) throw new Error("Hosted Turn alarm recovery was not committed");
    return Option.some(Option.getOrElse(nextRetention, () => now + hostedTranscriptRetentionMs));
  });

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
  subject: HostedSubject;
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
  const sessionAuthority = isWhatsAppHosted(subject)
    ? Option.none()
    : Option.some(
        webSessionCredentialAuthority({ subject: { ...subject, userId }, current: time })
      );
  const guard = Option.isNone(sessionAuthority)
    ? whatsAppCompletionGuard(status)
    : {
        sql: `AND (? <> 'completed' OR EXISTS (SELECT 1 FROM ${sessionAuthority.value.table}
          WHERE ${sessionAuthority.value.predicate}))`,
        bindings: [status, ...sessionAuthority.value.bindings],
      };
  return [
    db
      .prepare(`INSERT INTO transcript_entries
      (id, user_id, hosted_session_id, turn_id, kind, occurred_at_ms, text, failure_reason)
      SELECT ?, user_id, hosted_session_id, id, ?, ?, ?, ? FROM hosted_turns
      WHERE id = ? AND user_id = ? AND status = 'pending' ${guard.sql}`)
      .bind(entryId, kind, time, text, reason, turnId, userId, ...guard.bindings),
    db
      .prepare(`UPDATE hosted_turns SET status = ?, terminal_at_ms = ?, failure_reason = ?
      WHERE id = ? AND user_id = ? AND status = 'pending' ${guard.sql}`)
      .bind(status, time, reason, turnId, userId, ...guard.bindings),
    db
      .prepare(`DELETE FROM hosted_delivery_proposals WHERE turn_id = ? AND user_id = ?
      AND EXISTS (SELECT 1 FROM hosted_turns WHERE id = ? AND user_id = ? AND status <> 'pending')`)
      .bind(turnId, userId, turnId, userId),
    prepareWhatsAppWorkCleanup({ db, turnId, userId, requireTerminal: true }),
    db
      .prepare(`UPDATE hosted_agent_sessions SET last_activity_at_ms = ? WHERE user_id = ?
      AND id = (SELECT hosted_session_id FROM hosted_turns WHERE id = ? AND user_id = ?
        AND status <> 'pending')`)
      .bind(result._tag === "Interrupted" ? startedAtMs : time, userId, turnId, userId),
  ];
};

/** One terminal transition, with exact visible text or fixed metadata-only marker in the same batch. */
export const finishHostedTurn = (
  input: HostedFinishInput
): Effect.Effect<boolean, Cause.UnknownError | Schema.SchemaError | WhatsAppUnavailable> =>
  Effect.gen(function* () {
    const results = yield* Effect.tryPromise(() => input.db.batch(hostedFinishStatements(input)));
    return results[0]?.meta.changes === 1 && results[1]?.meta.changes === 1;
  });
