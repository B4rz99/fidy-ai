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
type DeliveryTarget = Readonly<{ identity: OwnedStatement }> &
  (
    | Readonly<{
        table: "weekly_question_requests";
        state: "state";
        attempted: "last_attempt_at_ms";
        restarts: "restart_attempts";
      }>
    | Readonly<{
        table: "proactive_messages";
        state: "dispatch_state";
        attempted: "dispatch_last_attempt_at_ms";
        restarts: "dispatch_restart_attempts";
      }>
  );
const deliveryTarget = (work: ProactivityDeliveryWork): DeliveryTarget =>
  work.kind === "weekly-question"
    ? {
        table: "weekly_question_requests",
        state: "state",
        attempted: "last_attempt_at_ms",
        restarts: "restart_attempts",
        identity: { sql: "user_id=? AND id=?", params: [work.userId, work.id] },
      }
    : {
        table: "proactive_messages",
        state: "dispatch_state",
        attempted: "dispatch_last_attempt_at_ms",
        restarts: "dispatch_restart_attempts",
        identity: {
          sql: "user_id=? AND kind=? AND id=?",
          params: [
            work.userId,
            work.kind,
            work.kind === "weekly-summary" ? work.insightEventId : work.id,
          ],
        },
      };

const ExpiringWork = Schema.Struct({
  user_id: Schema.String,
  kind: Schema.Literals(["weekly-summary", "weekly-question", "proactivity-delivery"]),
  delivery_id: Schema.String,
});
const expiryStatement = (
  db: D1Database,
  work: typeof ExpiringWork.Type,
  now: number
): D1PreparedStatement =>
  work.kind === "weekly-question"
    ? db
        .prepare(
          "UPDATE weekly_question_requests SET state='expired' WHERE user_id=? AND id=? AND state='ready' AND created_at_ms+86400000<=?"
        )
        .bind(work.user_id, work.delivery_id, now)
    : db
        .prepare(
          `UPDATE proactive_messages SET dispatch_state='expired' WHERE user_id=? AND kind=? AND id=? AND dispatch_state='ready' AND expires_at_ms<=? AND (kind='weekly-summary' OR NOT EXISTS(SELECT 1 FROM (${startedProactivity.sql}) c WHERE c.user_id=proactive_messages.user_id AND c.delivery_id=proactive_messages.id))`
        )
        .bind(work.user_id, work.kind, work.delivery_id, now);

/** Metadata-only cleanup selects at most one shared batch and rechecks each deadline/send proof at commit. */
export const expireDeliveryWork = (
  input: Readonly<{ db: D1Database; now: number }>
): Effect.Effect<void, InsightUnavailable> =>
  Effect.gen(function* () {
    const raw = yield* Effect.tryPromise(() =>
      input.db
        .prepare(
          `SELECT user_id,kind,delivery_id FROM proactivity_delivery_metadata o WHERE state='ready' AND expires_at_ms<=? AND (kind IN('weekly-summary','weekly-question') OR NOT EXISTS(SELECT 1 FROM (${startedProactivity.sql}) c WHERE c.user_id=o.user_id AND c.delivery_id=o.delivery_id)) ORDER BY expires_at_ms,user_id,kind,delivery_id LIMIT 64`
        )
        .bind(input.now)
        .all()
    );
    const expired = yield* Schema.decodeUnknownEffect(
      Schema.Array(ExpiringWork).check(Schema.isMaxLength(deliveryDiscoveryLimit))
    )(raw.results);
    yield* Effect.tryPromise(() =>
      input.db.batch([
        input.db.prepare(
          `UPDATE proactive_messages SET dispatch_state='started' WHERE rowid IN (SELECT o.rowid FROM proactive_messages AS o WHERE o.kind='proactivity-delivery' AND o.dispatch_state='ready' AND EXISTS (SELECT 1 FROM (${startedProactivity.sql}) AS c WHERE c.user_id=o.user_id AND c.delivery_id=o.id) LIMIT 64)`
        ),
        ...expired.map((work) => expiryStatement(input.db, work, input.now)),
        input.db
          .prepare(
            "UPDATE proactive_messages SET text=NULL WHERE rowid IN (SELECT rowid FROM proactive_messages WHERE kind='proactivity-delivery' AND text IS NOT NULL AND created_at_ms<=?-2592000000 LIMIT 64)"
          )
          .bind(input.now),
      ])
    );
  }).pipe(Effect.mapError(() => new InsightUnavailable()));
/** Persist a cumulative restart budget under the existing User coordinator; terminalization cannot authorize or repeat a provider send. */
export const recoverDeliveryWork = (
  input: Readonly<{ db: D1Database; userId: UserId; work: ProactivityDeliveryWork; now: number }>
): Effect.Effect<boolean, InsightUnavailable> =>
  Effect.gen(function* () {
    if (input.userId !== input.work.userId) return yield* new InsightUnavailable();
    const target = deliveryTarget(input.work);
    const identity = target.identity;
    const category = input.work.kind === "proactivity-delivery";
    const eligible = category
      ? `${target.state} IN ('ready','started')`
      : `${target.state}='ready'`;
    const lifetime =
      input.work.kind === "weekly-question"
        ? "created_at_ms+86400000>?"
        : `(expires_at_ms>? OR (kind='proactivity-delivery' AND (dispatch_state='started' OR EXISTS (SELECT 1 FROM (${startedProactivity.sql}) c WHERE c.user_id=proactive_messages.user_id AND c.delivery_id=proactive_messages.id))))`;
    const result = yield* Effect.tryPromise(() =>
      input.db.batch([
        input.db
          .prepare(
            `UPDATE ${target.table} SET ${target.restarts}=${target.restarts}+1 WHERE ${identity.sql} AND ${eligible} AND ${target.restarts}<? AND ${lifetime}`
          )
          .bind(...identity.params, maximumWorkflowRestarts, input.now),
        ...(category
          ? []
          : [
              input.db
                .prepare(
                  `UPDATE ${target.table} SET ${target.state}='refused' WHERE ${identity.sql} AND ${target.state}='ready' AND (${target.restarts}>=? OR NOT (${lifetime})) AND changes()=0`
                )
                .bind(...identity.params, maximumWorkflowRestarts, input.now),
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
          `SELECT kind,1 AS version,user_id AS userId,CASE WHEN kind='weekly-summary' THEN delivery_id END AS insightEventId,CASE WHEN kind<>'weekly-summary' THEN delivery_id END AS id,last_attempt_at_ms AS attempted,created_at_ms AS created FROM proactivity_delivery_metadata WHERE state='ready' AND last_attempt_at_ms<=? AND ((kind IN ('weekly-summary','weekly-question') AND ?=1) OR (kind='proactivity-delivery' AND ?=1)) ORDER BY attempted,created LIMIT 64`
        )
        .bind(
          input.now - redispatchIntervalMs,
          Number(input.weeklyEnabled),
          Number(input.proactivityEnabled)
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
    const target = deliveryTarget(input.work);
    const identity = target.identity;
    return input.db
      .prepare(`UPDATE ${target.table} SET ${target.attempted}=? WHERE ${identity.sql}`)
      .bind(input.now, ...identity.params)
      .run();
  }).pipe(
    Effect.asVoid,
    Effect.mapError(() => new InsightUnavailable())
  );

export const questionIntentQuery = (
  input: Readonly<{ userId: UserId; id: string }>
): OwnedStatement => ({
  sql: `SELECT 1 FROM weekly_question_requests AS i WHERE i.user_id=? AND i.id=? AND i.state='ready' AND (i.origin='requested' OR EXISTS (SELECT 1 FROM weekly_proactivity_state AS g WHERE g.user_id=i.user_id AND g.question_event_id=i.id AND g.question_needed=1 AND g.question_delivered=0 AND g.paused_at_ms IS NULL))`,
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
          `SELECT origin,created_at_ms,rejection_offer_id FROM weekly_question_requests WHERE user_id=? AND id=? AND state='ready' AND EXISTS (${guard.sql})`
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
    const target = deliveryTarget(input.work);
    const identity = target.identity;
    const eligible =
      input.work.kind === "weekly-question" ||
      (input.work.kind === "proactivity-delivery" &&
        (input.state === "started" || input.state === "expired"))
        ? `${target.state}='ready'`
        : `${target.state} NOT IN ('settled','expired','refused')`;
    return input.db
      .prepare(`UPDATE ${target.table} SET ${target.state}=? WHERE ${identity.sql} AND ${eligible}`)
      .bind(input.state, ...identity.params)
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
          sql: `INSERT INTO weekly_question_requests(id,user_id,origin,request_message_id,created_at_ms,rejection_offer_id,state,last_attempt_at_ms,restart_attempts) SELECT ?,?,'requested',?,?,NULLIF(?,''),'ready',0,0 WHERE EXISTS (${association.sql}) AND (SELECT count(*) FROM weekly_question_requests WHERE user_id=? AND origin='requested' AND created_at_ms>?)<8 AND NOT EXISTS (SELECT 1 FROM weekly_question_requests WHERE user_id=? AND request_message_id=?)`,
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
