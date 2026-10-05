import { type DateTime, Effect, Option, Schema } from "effect";
import { type UserId } from "../../../src/core/identity/contract";
import { type InsightEventId, ProactivityThresholds } from "../../../src/core/insights/contract";
import { type OwnedStatement } from "../../../src/shell/owner-write/contract";
import { prepareConsentAction } from "../../consent/operations";
import { InsightUnavailable, WeeklyGovernor } from "../contract";

export const pauseMention =
  "Pausé tus resúmenes semanales porque no recibí respuesta. Puedes pedirme que los reactive.";

export const findGovernor = (
  input: Readonly<{ db: D1Database; userId: UserId }>
): Effect.Effect<Option.Option<WeeklyGovernor>, InsightUnavailable> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      prepareConsentAction({
        ...input,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement: {
          sql: "SELECT unanswered,question_needed,question_delivered,paused_at_ms FROM weekly_governors WHERE user_id=?",
          params: [input.userId],
        },
      }).first()
    );
    if (raw === null) return Option.none();
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        unanswered: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 200 })),
        question_needed: Schema.Literals([0, 1]),
        question_delivered: Schema.Literals([0, 1]),
        paused_at_ms: Schema.NullOr(Schema.DateTimeUtcFromMillis),
      })
    )(raw);
    if (row.question_delivered === 1 && row.question_needed === 0) {
      return yield* new InsightUnavailable();
    }
    if (row.paused_at_ms !== null) {
      return Option.some(
        WeeklyGovernor.make({
          _tag: "Paused",
          unanswered: row.unanswered,
          pausedAt: row.paused_at_ms,
        })
      );
    }
    if (row.question_needed === 0) {
      return Option.some(WeeklyGovernor.make({ _tag: "Attentive", unanswered: row.unanswered }));
    }
    return Option.some(
      WeeklyGovernor.make({
        _tag: row.question_delivered === 0 ? "QuestionPending" : "QuestionDelivered",
        unanswered: row.unanswered,
      })
    );
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

/** The proof comes from the Channel's verified-delivery projection, not provider acceptance. */
export const prepareCount = (
  input: Readonly<{
    db: D1Database;
    userId: UserId;
    insightEventId: InsightEventId;
    proof: OwnedStatement;
    thresholds: ProactivityThresholds;
  }>
): ReadonlyArray<D1PreparedStatement> => {
  const thresholds = ProactivityThresholds.make(input.thresholds);
  const { db, userId, insightEventId, proof } = input;
  return [
    db
      .prepare(
        `INSERT INTO weekly_governors(user_id) SELECT ? WHERE EXISTS (SELECT 1 FROM insight_events WHERE user_id=? AND id=? AND kind='weekly-summary') AND EXISTS (SELECT 1 FROM (${proof.sql}) AS v WHERE v.user_id=? AND v.insight_event_id=?) ON CONFLICT(user_id) DO NOTHING`
      )
      .bind(userId, userId, insightEventId, ...proof.params, userId, insightEventId),
    db
      .prepare(
        `INSERT INTO weekly_governor_deliveries(user_id,insight_event_id) SELECT ?,? WHERE EXISTS (SELECT 1 FROM (${proof.sql}) AS v JOIN weekly_governors AS g ON g.user_id=v.user_id JOIN insight_events AS e ON e.user_id=v.user_id AND e.id=v.insight_event_id AND e.kind='weekly-summary' WHERE v.user_id=? AND v.insight_event_id=? AND v.delivered_at_ms > g.last_reply_at_ms AND g.paused_at_ms IS NULL AND (g.question_needed=0 OR (g.question_delivered=1 AND v.delivered_at_ms > g.question_delivered_at_ms))) ON CONFLICT DO NOTHING`
      )
      .bind(userId, insightEventId, ...proof.params, userId, insightEventId),
    db
      .prepare(
        `UPDATE weekly_governors SET unanswered=min(unanswered+1,200),question_needed=CASE WHEN unanswered+1 >= ? AND NOT EXISTS (SELECT 1 FROM weekly_consent_rejections WHERE user_id=weekly_governors.user_id) THEN 1 ELSE question_needed END,question_event_id=coalesce(question_event_id,CASE WHEN unanswered+1 >= ? AND NOT EXISTS (SELECT 1 FROM weekly_consent_rejections WHERE user_id=weekly_governors.user_id) THEN ? ELSE NULL END),paused_at_ms=CASE WHEN question_delivered=1 AND unanswered+1 >= ? THEN (SELECT delivered_at_ms FROM (${proof.sql}) AS v WHERE v.user_id=? AND v.insight_event_id=?) ELSE paused_at_ms END,notice_completed=CASE WHEN question_delivered=1 AND unanswered+1 >= ? THEN 0 ELSE notice_completed END WHERE user_id=? AND changes()=1`
      )
      .bind(
        thresholds.askAfter,
        thresholds.askAfter,
        insightEventId,
        thresholds.askAfter + thresholds.pauseAfter,
        ...proof.params,
        userId,
        insightEventId,
        thresholds.askAfter + thresholds.pauseAfter,
        userId
      ),
    db
      .prepare(
        `INSERT INTO weekly_question_intents(id,user_id,origin,created_at_ms) SELECT g.question_event_id,g.user_id,'proactive',v.delivered_at_ms FROM weekly_governors AS g JOIN (${proof.sql}) AS v ON v.user_id=g.user_id AND v.insight_event_id=g.question_event_id WHERE g.user_id=? AND g.question_needed=1 AND g.paused_at_ms IS NULL ON CONFLICT DO NOTHING`
      )
      .bind(...proof.params, userId),
    db
      .prepare(
        "UPDATE weekly_schedules SET enabled=0 WHERE user_id=? AND EXISTS (SELECT 1 FROM weekly_governors WHERE user_id=? AND paused_at_ms IS NOT NULL)"
      )
      .bind(userId, userId),
  ];
};

export const prepareReply = (
  input: Readonly<{ db: D1Database; userId: UserId; proof: OwnedStatement }>
): D1PreparedStatement =>
  input.db
    .prepare(
      `INSERT INTO weekly_governors(user_id,last_reply_at_ms) SELECT ?,max(v.occurred_at_ms) FROM (${input.proof.sql}) AS v LEFT JOIN insight_events AS e ON e.id=v.insight_event_id AND e.user_id=v.user_id WHERE v.user_id=? AND (e.kind='weekly-summary' OR v.question_id IS NOT NULL) AND v.occurred_at_ms+1000 >= v.delivered_at_ms GROUP BY v.user_id ON CONFLICT(user_id) DO UPDATE SET unanswered=0,last_reply_at_ms=excluded.last_reply_at_ms,question_needed=0,question_delivered=0,question_delivered_at_ms=NULL,question_event_id=NULL WHERE excluded.last_reply_at_ms > weekly_governors.last_reply_at_ms`
    )
    .bind(input.userId, ...input.proof.params, input.userId);

export const prepareQuestionDelivered = (
  input: Readonly<{ db: D1Database; userId: UserId; proof: OwnedStatement }>
): D1PreparedStatement =>
  input.db
    .prepare(
      `UPDATE weekly_governors SET question_delivered=1,question_delivered_at_ms=coalesce(question_delivered_at_ms,(SELECT min(v.delivered_at_ms) FROM (${input.proof.sql}) AS v WHERE v.user_id=? AND v.question_id=question_event_id)) WHERE user_id=? AND question_needed=1 AND paused_at_ms IS NULL AND EXISTS (SELECT 1 FROM (${input.proof.sql}) AS v WHERE v.user_id=? AND v.delivered_at_ms > last_reply_at_ms AND v.question_id=question_event_id)`
    )
    .bind(...input.proof.params, input.userId, input.userId, ...input.proof.params, input.userId);

export const prepareReset = (
  input: Readonly<{ db: D1Database; userId: UserId; now: DateTime.Utc }>
): D1PreparedStatement =>
  input.db
    .prepare(
      "UPDATE weekly_governors SET unanswered=0,last_reply_at_ms=?,question_needed=0,question_delivered=0,question_delivered_at_ms=NULL,question_event_id=NULL,paused_at_ms=NULL,notice_session_id=NULL,notice_turn_id=NULL,notice_completed=0 WHERE user_id=?"
    )
    .bind(input.now.epochMilliseconds, input.userId);

/** Bind a pending mention only to an admitted User request in the next session, never to a scheduler Turn. */
export const prepareNotice = (
  input: Readonly<{
    db: D1Database;
    userId: UserId;
    sessionId: string;
    turnId: string;
    newSession: boolean;
    proof: OwnedStatement;
  }>
): D1PreparedStatement =>
  input.db
    .prepare(
      `UPDATE weekly_governors SET notice_session_id=?,notice_turn_id=? WHERE user_id=? AND paused_at_ms IS NOT NULL AND notice_completed=0 AND (?=1 OR notice_session_id=?) AND EXISTS (${input.proof.sql})`
    )
    .bind(
      input.sessionId,
      input.turnId,
      input.userId,
      input.newSession ? 1 : 0,
      input.sessionId,
      ...input.proof.params
    );

export const readNotice = (
  input: Readonly<{ db: D1Database; userId: UserId; turnId: string }>
): Effect.Effect<Option.Option<string>, InsightUnavailable> =>
  Effect.tryPromise(() =>
    input.db
      .prepare(
        "SELECT 1 FROM weekly_governors WHERE user_id=? AND notice_turn_id=? AND paused_at_ms IS NOT NULL AND notice_completed=0"
      )
      .bind(input.userId, input.turnId)
      .first()
  ).pipe(
    Effect.map((row) => (row === null ? Option.none() : Option.some(pauseMention))),
    Effect.mapError(() => new InsightUnavailable())
  );

export const prepareNoticeCompletion = (
  input: Readonly<{ db: D1Database; userId: UserId; turnId: string; proof: OwnedStatement }>
): D1PreparedStatement =>
  input.db
    .prepare(
      `UPDATE weekly_governors SET notice_completed=1 WHERE user_id=? AND notice_turn_id=? AND EXISTS (SELECT 1 FROM (${input.proof.sql}) AS v WHERE v.user_id=? AND v.turn_id=? AND substr(v.text,1,length(?))=?)`
    )
    .bind(
      input.userId,
      input.turnId,
      ...input.proof.params,
      input.userId,
      input.turnId,
      pauseMention,
      pauseMention
    );
