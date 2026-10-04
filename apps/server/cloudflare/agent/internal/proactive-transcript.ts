import { type Cause, DateTime, Effect, Option, Schema } from "effect";
import {
  ProactiveInsightTranscriptEntry,
  TranscriptEntryId,
} from "../../../src/core/agent/contract";
import { type InsightEventId } from "../../../src/core/insights/contract";
import { type UserId } from "../../../src/core/identity/contract";
import { type OwnedStatement } from "../../../src/shell/owner-write/contract";
import { protectConsentStatement } from "../../../src/shell/consent/operations";
import { newId } from "../../secret-material/operations";
import { hostedTranscriptRetentionMs } from "../contract";

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
          sql: "SELECT id,insight_event_id,occurred_at_ms,text FROM proactive_transcript_entries WHERE user_id=? AND insight_event_id=? AND expires_at_ms>?",
          params: [input.userId, input.insightEventId, input.now],
        },
      }).first()
    );
    if (raw === null) {
      return Option.none();
    }
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        id: TranscriptEntryId,
        insight_event_id: ProactiveInsightTranscriptEntry.fields.insightEventId,
        occurred_at_ms: Schema.Int,
        text: ProactiveInsightTranscriptEntry.fields.text,
      })
    )(raw);
    return Option.some(
      yield* Schema.decodeEffect(Schema.toCodecJson(ProactiveInsightTranscriptEntry))({
        _tag: "ProactiveInsightTranscriptEntry",
        id: row.id,
        insightEventId: row.insight_event_id,
        occurredAt: DateTime.formatIso(DateTime.makeUnsafe(row.occurred_at_ms)),
        text: row.text,
      })
    );
  });
/** Fixed thirty-day deletion is executable independently of any later User message. */
export const expireProactiveTranscript = (
  input: Readonly<{ db: D1Database; userId: UserId; now: number }>
): Effect.Effect<void, Cause.UnknownError> =>
  Effect.tryPromise(() =>
    input.db
      .prepare("DELETE FROM proactive_transcript_entries WHERE user_id=? AND expires_at_ms<=?")
      .bind(input.userId, input.now)
      .run()
  ).pipe(Effect.asVoid);
