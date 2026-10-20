import { type DateTime, Effect, Option, Schema } from "effect";
import { ConsentRecordId } from "../../../src/core/consent/contract";
import { type UserId, type WhatsAppCallerReference } from "../../../src/core/identity/contract";
import { type OwnedStatement } from "../../../src/shell/owner-write/contract";
import { whatsAppAssociationQuery } from "../../../src/shell/identity/operations";
import { latestWeeklyConsentRejection, prepareConsentAction } from "../../consent/operations";
import { newId } from "../../secret-material/operations";
import { InsightUnavailable, ProactivityDeliveryWork, type WeeklyQuestionWork } from "../contract";

import { proactivityStartedDeliveryQuery } from "../../whatsapp/operations";

const startedProactivity = proactivityStartedDeliveryQuery();
const redispatchIntervalMs = 60000;
const deliveryDiscoveryLimit = 64;
const requestWindowMs = 86400000;

const maximumWorkflowRestarts = 3;
const deliveryLocation = (
  work: ProactivityDeliveryWork
): Readonly<{
  table: "weekly_question_intents" | "insight_reports";
  identity: OwnedStatement;
  state: "state" | "dispatch_state";
  attempts: "restart_attempts" | "dispatch_restart_attempts";
  lastAttempt: "last_attempt_at_ms" | "dispatch_last_attempt_at_ms";
}> => ({
  table: work.kind === "weekly-question" ? "weekly_question_intents" : "insight_reports",
  state: work.kind === "weekly-question" ? "state" : "dispatch_state",
  attempts: work.kind === "weekly-question" ? "restart_attempts" : "dispatch_restart_attempts",
  lastAttempt:
    work.kind === "weekly-question" ? "last_attempt_at_ms" : "dispatch_last_attempt_at_ms",
  identity:
    work.kind === "weekly-question"
      ? { sql: "user_id=? AND id=?", params: [work.userId, work.id] }
      : {
          sql: "user_id=? AND kind=? AND delivery_id=?",
          params: [
            work.userId,
            work.kind,
            work.kind === "weekly-summary" ? work.insightEventId : work.id,
          ],
        },
});

/** Metadata-only cleanup does not require processing Consent or read any recipient/report body. */
export const expireDeliveryWork = (
  input: Readonly<{ db: D1Database; now: number }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.tryPromise(() =>
    input.db.batch([
      input.db.prepare(
        `UPDATE insight_reports SET dispatch_state='started' WHERE rowid IN (SELECT o.rowid FROM insight_reports AS o WHERE o.kind='proactivity-delivery' AND o.dispatch_state='ready' AND EXISTS (SELECT 1 FROM (${startedProactivity.sql}) AS c WHERE c.user_id=o.user_id AND c.delivery_id=o.delivery_id) LIMIT 64)`
      ),
      input.db
        .prepare(
          `UPDATE insight_reports SET dispatch_state='expired' WHERE (user_id,kind,delivery_id) IN (SELECT o.user_id,o.kind,o.delivery_id FROM proactivity_delivery_metadata o WHERE o.state='ready' AND o.expires_at_ms<=? AND (o.kind='weekly-summary' OR NOT EXISTS (SELECT 1 FROM (${startedProactivity.sql}) AS c WHERE c.user_id=o.user_id AND c.delivery_id=o.delivery_id)) LIMIT 64)`
        )
        .bind(input.now),
      input.db
        .prepare(
          "UPDATE insight_reports SET text=NULL WHERE rowid IN (SELECT rowid FROM insight_reports WHERE kind='proactivity-delivery' AND text IS NOT NULL AND created_at_ms<=?-2592000000 LIMIT 64)"
        )
        .bind(input.now),
      input.db
        .prepare(
          "UPDATE weekly_question_intents SET state='expired' WHERE id IN (SELECT id FROM weekly_question_intents WHERE state='ready' AND created_at_ms+?<=? LIMIT 64)"
        )
        .bind(requestWindowMs, input.now),
    ])
  ).pipe(
    Effect.asVoid,
    Effect.mapError(() => new InsightUnavailable())
  );
/** Persist a cumulative restart budget under the existing User coordinator; terminalization cannot authorize or repeat a provider send. */
export const recoverDeliveryWork = (
  input: Readonly<{ db: D1Database; userId: UserId; work: ProactivityDeliveryWork; now: number }>
): Effect.Effect<boolean, InsightUnavailable> =>
  Effect.gen(function* () {
    if (input.userId !== input.work.userId) return yield* new InsightUnavailable();
    const location = deliveryLocation(input.work);
    const category = input.work.kind === "proactivity-delivery";
    const eligible = category
      ? `${location.state} IN ('ready','started')`
      : `${location.state}='ready'`;
    const lifetime =
      input.work.kind === "weekly-question"
        ? "created_at_ms+86400000>?"
        : `(expires_at_ms>? OR (kind='proactivity-delivery' AND (dispatch_state='started' OR EXISTS (SELECT 1 FROM (${startedProactivity.sql}) c WHERE c.user_id=insight_reports.user_id AND c.delivery_id=insight_reports.delivery_id))))`;
    const result = yield* Effect.tryPromise(() =>
      input.db.batch([
        input.db
          .prepare(
            `UPDATE ${location.table} SET ${location.attempts}=${location.attempts}+1 WHERE ${location.identity.sql} AND ${eligible} AND ${location.attempts}<? AND ${lifetime}`
          )
          .bind(...location.identity.params, maximumWorkflowRestarts, input.now),
        ...(category
          ? []
          : [
              input.db
                .prepare(
                  `UPDATE ${location.table} SET ${location.state}='refused' WHERE ${location.identity.sql} AND ${location.state}='ready' AND (${location.attempts}>=? OR NOT (${lifetime})) AND changes()=0`
                )
                .bind(...location.identity.params, maximumWorkflowRestarts, input.now),
            ]),
      ])
    );
    return result[0]?.meta.changes === 1;
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

export const discoverDeliveryWork = (
  input: Readonly<{
    db: D1Database;
    now: number;
    weeklyEnabled: boolean;
    proactivityEnabled: boolean;
  }>
): Effect.Effect<ReadonlyArray<ProactivityDeliveryWork>, InsightUnavailable> =>
  Effect.gen(function* () {
    const result = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          `SELECT kind,1 AS version,user_id AS userId,CASE WHEN kind='weekly-summary' THEN delivery_id END AS insightEventId,CASE WHEN kind='proactivity-delivery' THEN delivery_id END AS id,dispatch_last_attempt_at_ms AS attempted,dispatch_created_at_ms AS created FROM insight_reports WHERE dispatch_state='ready' AND dispatch_last_attempt_at_ms<=? AND ((kind='weekly-summary' AND ?=1) OR (kind='proactivity-delivery' AND ?=1)) UNION ALL SELECT 'weekly-question',1,user_id,NULL,id,last_attempt_at_ms,created_at_ms FROM weekly_question_intents WHERE state='ready' AND last_attempt_at_ms<=? AND ?=1 ORDER BY attempted,created LIMIT 64`
        )
        .bind(
          input.now - redispatchIntervalMs,
          Number(input.weeklyEnabled),
          Number(input.proactivityEnabled),
          input.now - redispatchIntervalMs,
          Number(input.weeklyEnabled)
        )
        .all()
    );
    return yield* Schema.decodeUnknownEffect(
      Schema.Array(ProactivityDeliveryWork).check(Schema.isMaxLength(deliveryDiscoveryLimit))
    )(result.results);
  }).pipe(Effect.mapError(() => new InsightUnavailable()));

export const markOffered = (
  input: Readonly<{ db: D1Database; work: ProactivityDeliveryWork; now: number }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.tryPromise(() => {
    const location = deliveryLocation(input.work);
    return input.db
      .prepare(
        `UPDATE ${location.table} SET ${location.lastAttempt}=? WHERE ${location.identity.sql}`
      )
      .bind(input.now, ...location.identity.params)
      .run();
  }).pipe(
    Effect.asVoid,
    Effect.mapError(() => new InsightUnavailable())
  );

export const questionIntentQuery = (
  input: Readonly<{ userId: UserId; id: string }>
): OwnedStatement => ({
  sql: `SELECT 1 FROM weekly_question_intents AS i WHERE i.user_id=? AND i.id=? AND i.state='ready' AND (i.origin='requested' OR EXISTS (SELECT 1 FROM (SELECT rowid,* FROM proactivity_governors WHERE kind='weekly') AS g WHERE g.user_id=i.user_id AND g.question_event_id=i.id AND g.question_needed=1 AND g.question_delivered=0 AND g.paused_at_ms IS NULL))`,
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
    work: ProactivityDeliveryWork;
    state: "started" | "settled" | "expired" | "refused";
  }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.tryPromise(() => {
    const location = deliveryLocation(input.work);
    const eligible =
      input.work.kind === "weekly-question" ||
      (input.work.kind === "proactivity-delivery" &&
        (input.state === "started" || input.state === "expired"))
        ? `${location.state}='ready'`
        : `${location.state} NOT IN ('settled','expired','refused')`;
    return input.db
      .prepare(
        `UPDATE ${location.table} SET ${location.state}=? WHERE ${location.identity.sql} AND ${eligible}`
      )
      .bind(input.state, ...location.identity.params)
      .run();
  }).pipe(
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
