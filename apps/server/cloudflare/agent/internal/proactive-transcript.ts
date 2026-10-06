import { type Cause, Effect, Option, Schema } from "effect";
import {
  ProactiveInsightTranscriptEntry,
  ProactiveMessageTranscriptEntry,
  TranscriptEntryId,
} from "../../../src/core/agent/contract";
import { type InsightEventId } from "../../../src/core/insights/contract";
import { type UserId } from "../../../src/core/identity/contract";
import { type OwnedStatement } from "../../../src/shell/owner-write/contract";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { newId } from "../../secret-material/operations";
import {
  AgentUnavailable,
  type ProactiveReplyContext,
  hostedTranscriptRetentionMs,
} from "../contract";

const prepareProtected = (
  input: Readonly<{
    db: D1Database;
    subject: Readonly<{ _tag: "User"; userId: UserId }>;
    requirement: "active";
    statement: OwnedStatement;
  }>
): D1PreparedStatement => {
  const query = protectConsentStatement(input);
  return input.db.prepare(query.sql).bind(...query.params);
};

/** Compose one exact verified visible message with Insights settlement. No requested Turn or session is invented. */
export const prepareProactiveTranscript = (
  input: Readonly<{
    db: D1Database;
    userId: UserId;
    insightEventId: InsightEventId;
    now: number;
    proof: OwnedStatement;
  }>
): ReadonlyArray<D1PreparedStatement> => [
  prepareProtected({
    db: input.db,
    subject: { _tag: "User", userId: input.userId },
    requirement: "active",
    statement: {
      sql: `INSERT INTO proactive_transcript_entries(id,user_id,insight_event_id,occurred_at_ms,text,expires_at_ms)
 SELECT ?,v.user_id,v.insight_event_id,v.delivered_at_ms,v.text,v.delivered_at_ms + ? FROM (${input.proof.sql}) AS v
 WHERE v.user_id=? AND v.insight_event_id=? AND v.text IS NOT NULL AND v.delivered_at_ms + ? > ? AND NOT EXISTS (SELECT 1 FROM proactive_transcript_entries WHERE user_id=? AND insight_event_id=?)`,
      params: [
        TranscriptEntryId.make(newId()),
        hostedTranscriptRetentionMs,
        ...input.proof.params,
        input.userId,
        input.insightEventId,
        hostedTranscriptRetentionMs,
        input.now,
        input.userId,
        input.insightEventId,
      ],
    },
  }),
];
export const prepareMessageTranscript = (
  input: Readonly<{
    db: D1Database;
    userId: UserId;
    id: string;
    now: number;
    proof: OwnedStatement;
  }>
): D1PreparedStatement =>
  prepareProtected({
    db: input.db,
    subject: { _tag: "User", userId: input.userId },
    requirement: "active",
    statement: {
      sql: `INSERT OR IGNORE INTO proactive_message_transcript_entries(id,user_id,delivery_id,role,occurred_at_ms,text,expires_at_ms) SELECT ?,v.user_id,v.delivery_id,v.role,v.delivered_at_ms,v.text,v.delivered_at_ms+? FROM (${input.proof.sql}) AS v WHERE v.user_id=? AND v.delivery_id=? AND v.role IN ('budget-offer','reminder-offer','reminder-question') AND v.text IS NOT NULL AND v.delivered_at_ms+?>?`,
      params: [
        newId(),
        hostedTranscriptRetentionMs,
        ...input.proof.params,
        input.userId,
        input.id,
        hostedTranscriptRetentionMs,
        input.now,
      ],
    },
  });

export const prepareGroupedProactiveTranscript = (
  input: Parameters<typeof prepareProactiveTranscript>[0] & Readonly<{ links: OwnedStatement }>
): ReadonlyArray<D1PreparedStatement> => [
  ...prepareProactiveTranscript(input),
  prepareProtected({
    db: input.db,
    subject: { _tag: "User", userId: input.userId },
    requirement: "active",
    statement: {
      sql: `INSERT OR IGNORE INTO proactive_transcript_event_links(user_id,transcript_id,insight_event_id) SELECT p.user_id,p.id,l.insight_event_id FROM proactive_transcript_entries AS p JOIN (${input.links.sql}) AS l ON l.user_id=p.user_id WHERE p.user_id=? AND p.insight_event_id=? AND p.expires_at_ms>?`,
      params: [...input.links.params, input.userId, input.insightEventId, input.now],
    },
  }),
];
/** Read only the verified message referenced by the authenticated WhatsApp request, with no fabricated session history. */
export const readContextualProactiveReply = (
  input: Readonly<{
    db: D1Database;
    userId: UserId;
    now: number;
    proof: Option.Option<OwnedStatement>;
  }>
): Effect.Effect<Option.Option<ProactiveReplyContext>, AgentUnavailable> =>
  Effect.gen(function* () {
    if (Option.isNone(input.proof)) return Option.none();
    const proof = input.proof.value;
    const raw = yield* Effect.tryPromise(() =>
      prepareProtected({
        db: input.db,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement: {
          sql: `SELECT p.id,p.insight_event_id,p.occurred_at_ms,p.text FROM proactive_transcript_entries AS p WHERE p.user_id=? AND p.expires_at_ms>? AND EXISTS (SELECT 1 FROM (${proof.sql}) AS v WHERE v.user_id=p.user_id AND v.insight_event_id=p.insight_event_id)`,
          params: [input.userId, input.now, ...proof.params],
        },
      }).first()
    );
    const entry = yield* decodeProactiveEntry(raw);
    if (Option.isSome(entry)) return Option.some({ userId: input.userId, entry: entry.value });
    const messageRaw = yield* Effect.tryPromise(() =>
      prepareProtected({
        db: input.db,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement: {
          sql: `SELECT p.id,p.delivery_id,p.role,p.occurred_at_ms,p.text FROM proactive_message_transcript_entries AS p WHERE p.user_id=? AND p.expires_at_ms>? AND EXISTS (SELECT 1 FROM (${proof.sql}) AS v WHERE v.user_id=p.user_id AND v.delivery_id=p.delivery_id)`,
          params: [input.userId, input.now, ...proof.params],
        },
      }).first()
    );
    return Option.map(yield* decodeMessageEntry(messageRaw), (value) => ({
      userId: input.userId,
      entry: value,
    }));
  }).pipe(Effect.mapError(() => new AgentUnavailable()));

/** Exact same-User evidence for correlated ordinary replies, not a fabricated prior Turn. */
export const readProactiveTranscript = (
  input: Readonly<{ db: D1Database; userId: UserId; insightEventId: InsightEventId; now: number }>
): Effect.Effect<
  Option.Option<ProactiveInsightTranscriptEntry>,
  Cause.UnknownError | Schema.SchemaError
> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      prepareProtected({
        db: input.db,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement: {
          sql: "SELECT p.id,p.insight_event_id,p.occurred_at_ms,p.text FROM proactive_transcript_entries AS p WHERE p.user_id=? AND EXISTS (SELECT 1 FROM proactive_transcript_event_links AS l WHERE l.user_id=p.user_id AND l.transcript_id=p.id AND l.insight_event_id=?) AND p.expires_at_ms>?",
          params: [input.userId, input.insightEventId, input.now],
        },
      }).first()
    );
    return yield* decodeProactiveEntry(raw);
  });

export const findMessageTranscript = (
  input: Readonly<{ db: D1Database; userId: UserId; id: string; now: number }>
): Effect.Effect<Option.Option<ProactiveMessageTranscriptEntry>, AgentUnavailable> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      prepareProtected({
        db: input.db,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement: {
          sql: "SELECT id,delivery_id,role,occurred_at_ms,text FROM proactive_message_transcript_entries WHERE user_id=? AND delivery_id=? AND expires_at_ms>?",
          params: [input.userId, input.id, input.now],
        },
      }).first()
    );
    return yield* decodeMessageEntry(raw);
  }).pipe(Effect.mapError(() => new AgentUnavailable()));
const decodeMessageEntry = (
  raw: unknown
): Effect.Effect<Option.Option<ProactiveMessageTranscriptEntry>, Schema.SchemaError> =>
  Effect.gen(function* () {
    if (raw === null) return Option.none();
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        id: TranscriptEntryId,
        delivery_id: ProactiveMessageTranscriptEntry.fields.deliveryId,
        role: ProactiveMessageTranscriptEntry.fields.role,
        occurred_at_ms: Schema.DateTimeUtcFromMillis,
        text: ProactiveMessageTranscriptEntry.fields.text,
      })
    )(raw);
    return Option.some({
      _tag: "ProactiveMessageTranscriptEntry",
      id: row.id,
      deliveryId: row.delivery_id,
      role: row.role,
      occurredAt: row.occurred_at_ms,
      text: row.text,
    });
  });

const decodeProactiveEntry = (
  raw: unknown
): Effect.Effect<Option.Option<ProactiveInsightTranscriptEntry>, Schema.SchemaError> =>
  Effect.gen(function* () {
    if (raw === null) return Option.none();
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        id: TranscriptEntryId,
        insight_event_id: ProactiveInsightTranscriptEntry.fields.insightEventId,
        occurred_at_ms: Schema.DateTimeUtcFromMillis,
        text: ProactiveInsightTranscriptEntry.fields.text,
      })
    )(raw);
    return Option.some(
      yield* Schema.decodeEffect(Schema.toType(ProactiveInsightTranscriptEntry))({
        _tag: "ProactiveInsightTranscriptEntry",
        id: row.id,
        insightEventId: row.insight_event_id,
        occurredAt: row.occurred_at_ms,
        text: row.text,
      })
    );
  });
/** Maintenance also covers proactive-only Users, without manufacturing an Agent Session or Turn. */
export const sweepProactiveTranscript = (
  input: Readonly<{ db: D1Database; now: number }>
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    input.db.batch([
      input.db
        .prepare(
          "DELETE FROM proactive_transcript_entries WHERE id IN (SELECT id FROM proactive_transcript_entries WHERE expires_at_ms<=? ORDER BY expires_at_ms LIMIT 128)"
        )
        .bind(input.now),
      input.db
        .prepare(
          "DELETE FROM proactive_message_transcript_entries WHERE id IN (SELECT id FROM proactive_message_transcript_entries WHERE expires_at_ms<=? ORDER BY expires_at_ms,id LIMIT 128)"
        )
        .bind(input.now),
    ])
  ).pipe(Effect.asVoid);

/** Fixed thirty-day deletion is executable independently of any later User message. */
export const expireProactiveTranscript = (
  input: Readonly<{ db: D1Database; userId: UserId; now: number }>
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    input.db.batch([
      input.db
        .prepare("DELETE FROM proactive_transcript_entries WHERE user_id=? AND expires_at_ms<=?")
        .bind(input.userId, input.now),
      input.db
        .prepare(
          "DELETE FROM proactive_message_transcript_entries WHERE user_id=? AND expires_at_ms<=?"
        )
        .bind(input.userId, input.now),
    ])
  ).pipe(Effect.asVoid);
