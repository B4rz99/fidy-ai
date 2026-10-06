import { type DateTime, Effect, Option, Schema } from "effect";
import { ConsentRecordId } from "../../../src/core/consent/contract";
import { type UserId, type WhatsAppCallerReference } from "../../../src/core/identity/contract";
import { type OwnedStatement } from "../../../src/shell/owner-write/contract";
import { whatsAppAssociationQuery } from "../../../src/shell/identity/operations";
import { latestWeeklyConsentRejection, prepareConsentAction } from "../../consent/operations";
import { newId } from "../../secret-material/operations";
import { InsightUnavailable, WeeklyDeliveryWork, type WeeklyQuestionWork } from "../contract";

const redispatchIntervalMs = 60000;
const deliveryDiscoveryLimit = 64;
const requestWindowMs = 86400000;

const maximumWorkflowRestarts = 3;
/** Metadata-only cleanup does not require processing Consent or read any recipient/report body. */
export const expireDeliveryWork = (
  input: Readonly<{ db: D1Database; now: number }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.tryPromise(() =>
    input.db.batch([
      input.db
        .prepare(
          "UPDATE weekly_question_intents SET state='expired' WHERE id IN (SELECT id FROM weekly_question_intents WHERE state='ready' AND created_at_ms+?<=? LIMIT 64)"
        )
        .bind(requestWindowMs, input.now),
      input.db
        .prepare(
          "UPDATE weekly_summary_outbox SET state='expired' WHERE insight_event_id IN (SELECT o.insight_event_id FROM weekly_summary_outbox AS o JOIN weekly_summary_reports AS r ON r.user_id=o.user_id AND r.insight_event_id=o.insight_event_id WHERE o.state='ready' AND r.expires_at_ms<=? LIMIT 64)"
        )
        .bind(input.now),
    ])
  ).pipe(
    Effect.asVoid,
    Effect.mapError(() => new InsightUnavailable())
  );
/** Persist a cumulative restart budget under the existing User coordinator; terminalization cannot authorize or repeat a provider send. */
export const recoverDeliveryWork = (
  input: Readonly<{ db: D1Database; userId: UserId; work: WeeklyDeliveryWork; now: number }>
): Effect.Effect<boolean, InsightUnavailable> =>
  Effect.gen(function* () {
    if (input.userId !== input.work.userId) return yield* new InsightUnavailable();
    const summary = input.work.kind === "weekly-summary";
    const table = summary ? "weekly_summary_outbox" : "weekly_question_intents";
    const key = summary ? "insight_event_id" : "id";
    const id = input.work.kind === "weekly-summary" ? input.work.insightEventId : input.work.id;
    const lifetime = summary
      ? "EXISTS (SELECT 1 FROM weekly_summary_reports AS r WHERE r.user_id=weekly_summary_outbox.user_id AND r.insight_event_id=weekly_summary_outbox.insight_event_id AND r.expires_at_ms>?)"
      : "created_at_ms+86400000>?";
    const result = yield* Effect.tryPromise(() =>
      input.db.batch([
        input.db
          .prepare(
            `UPDATE ${table} SET restart_attempts=restart_attempts+1 WHERE user_id=? AND ${key}=? AND state='ready' AND restart_attempts<? AND ${lifetime}`
          )
          .bind(input.userId, id, maximumWorkflowRestarts, input.now),
        input.db
          .prepare(
            `UPDATE ${table} SET state='refused' WHERE user_id=? AND ${key}=? AND state='ready' AND (restart_attempts>=? OR NOT (${lifetime})) AND changes()=0`
          )
          .bind(input.userId, id, maximumWorkflowRestarts, input.now),
      ])
    );
    return result[0]?.meta.changes === 1;
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

export const discoverDeliveryWork = (
  input: Readonly<{ db: D1Database; now: number }>
): Effect.Effect<ReadonlyArray<WeeklyDeliveryWork>, InsightUnavailable> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          `SELECT 'weekly-summary' AS kind,1 AS version,user_id AS userId,insight_event_id AS insightEventId,NULL AS id,last_attempt_at_ms AS attempted,created_at_ms AS created FROM weekly_summary_outbox WHERE state='ready' AND last_attempt_at_ms<=? UNION ALL SELECT 'weekly-question',1,user_id,NULL,id,last_attempt_at_ms,created_at_ms FROM weekly_question_intents WHERE state='ready' AND last_attempt_at_ms<=? ORDER BY attempted,created LIMIT 64`
        )
        .bind(input.now - redispatchIntervalMs, input.now - redispatchIntervalMs)
        .all()
    );
    return yield* Schema.decodeUnknownEffect(
      Schema.Array(WeeklyDeliveryWork).check(Schema.isMaxLength(deliveryDiscoveryLimit))
    )(result.results);
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

export const markOffered = (
  input: Readonly<{ db: D1Database; work: WeeklyDeliveryWork; now: number }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.tryPromise(() =>
    input.work.kind === "weekly-summary"
      ? input.db
          .prepare(
            "UPDATE weekly_summary_outbox SET last_attempt_at_ms=? WHERE user_id=? AND insight_event_id=?"
          )
          .bind(input.now, input.work.userId, input.work.insightEventId)
          .run()
      : input.db
          .prepare(
            "UPDATE weekly_question_intents SET last_attempt_at_ms=? WHERE user_id=? AND id=?"
          )
          .bind(input.now, input.work.userId, input.work.id)
          .run()
  ).pipe(
    Effect.asVoid,
    Effect.mapError(() => new InsightUnavailable())
  );

export const questionIntentQuery = (
  input: Readonly<{ userId: UserId; id: string }>
): OwnedStatement => ({
  sql: `SELECT 1 FROM weekly_question_intents AS i WHERE i.user_id=? AND i.id=? AND i.state='ready' AND (i.origin='requested' OR EXISTS (SELECT 1 FROM weekly_governors AS g WHERE g.user_id=i.user_id AND g.question_event_id=i.id AND g.question_needed=1 AND g.question_delivered=0 AND g.paused_at_ms IS NULL))`,
  params: [input.userId, input.id],
});

export const findQuestionOrigin = (
  input: Readonly<{ db: D1Database; work: WeeklyQuestionWork }>
): Effect.Effect<
  Option.Option<
    Readonly<{
      origin: "requested" | "proactive";
      createdAt: DateTime.Utc;
      rejectionOfferId: Option.Option<ConsentRecordId>;
    }>
  >,
  InsightUnavailable
> =>
  Effect.gen(function* () {
    const guard = questionIntentQuery({ userId: input.work.userId, id: input.work.id });
    const raw = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          `SELECT origin,created_at_ms,rejection_offer_id FROM weekly_question_intents WHERE user_id=? AND id=? AND state='ready' AND EXISTS (${guard.sql})`
        )
        .bind(input.work.userId, input.work.id, ...guard.params)
        .first()
    );
    if (raw === null) return Option.none();
    const row = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        origin: Schema.Literals(["requested", "proactive"]),
        created_at_ms: Schema.DateTimeUtcFromMillis,
        rejection_offer_id: Schema.OptionFromNullOr(ConsentRecordId),
      })
    )(raw);
    return Option.some({
      origin: row.origin,
      createdAt: row.created_at_ms,
      rejectionOfferId: row.rejection_offer_id,
    });
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

export const settleDeliveryWork = (
  input: Readonly<{
    db: D1Database;
    work: WeeklyDeliveryWork;
    state: "started" | "settled" | "expired" | "refused";
  }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.tryPromise(() =>
    input.work.kind === "weekly-summary"
      ? input.db
          .prepare(
            "UPDATE weekly_summary_outbox SET state=? WHERE user_id=? AND insight_event_id=? AND state NOT IN ('settled','expired','refused')"
          )
          .bind(input.state, input.work.userId, input.work.insightEventId)
          .run()
      : input.db
          .prepare(
            "UPDATE weekly_question_intents SET state=? WHERE user_id=? AND id=? AND state='ready'"
          )
          .bind(input.state, input.work.userId, input.work.id)
          .run()
  ).pipe(
    Effect.asVoid,
    Effect.mapError(() => new InsightUnavailable())
  );

export const requestQuestion = (
  input: Readonly<{
    db: D1Database;
    userId: UserId;
    caller: WhatsAppCallerReference;
    messageId: string;
    now: DateTime.Utc;
  }>
): Effect.Effect<void, InsightUnavailable> => {
  const association = whatsAppAssociationQuery(input);
  return Effect.gen(function* () {
    const rejection = yield* latestWeeklyConsentRejection(input);
    yield* Effect.tryPromise(() =>
      prepareConsentAction({
        db: input.db,
        subject: { _tag: "User", userId: input.userId },
        requirement: "active",
        statement: {
          sql: `INSERT INTO weekly_question_intents(id,user_id,origin,request_message_id,created_at_ms,rejection_offer_id) SELECT ?,?,'requested',?,?,NULLIF(?,'') WHERE EXISTS (${association.sql}) AND (SELECT count(*) FROM weekly_question_intents WHERE user_id=? AND origin='requested' AND created_at_ms>?)<8 AND NOT EXISTS (SELECT 1 FROM weekly_question_intents WHERE user_id=? AND request_message_id=?)`,
          params: [
            newId(),
            input.userId,
            input.messageId,
            input.now.epochMilliseconds,
            Option.getOrElse(rejection, () => ""),
            ...association.params,
            input.userId,
            input.now.epochMilliseconds - requestWindowMs,
            input.userId,
            input.messageId,
          ],
        },
      }).run()
    );
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
};
