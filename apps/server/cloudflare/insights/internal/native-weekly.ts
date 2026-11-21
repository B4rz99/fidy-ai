import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { DateTime, Effect, Option, Predicate, Result, Schema } from "effect";
import { WeeklySchedule } from "../../../src/core/insights/contract";
import { nextWeeklyOccurrence } from "../../../src/core/insights/operations";
import { ConsentRecordId, DisclosureSnapshot } from "../../../src/core/consent/contract";
import { weeklyDisclosureFor } from "../../../src/shell/consent/operations";
import {
  WeeklyQuestionOffer,
  type WeeklyQuestionSender,
} from "../../../src/shell/channels/whatsapp/contract";
import { preserveStoreAlarm } from "../../runtime/sqlite/operations";
import type { NativeReminderEnvironment } from "../contract";
import { UserId } from "../../../src/core/identity/contract";
import { Hex } from "effect/encoding";
import { WeeklyThresholdConfiguration } from "../contract";
import type { WhatsAppTurnAdmission } from "../../whatsapp/contract";
import { digestBytes, newId } from "../../secret-material/operations";

const retryMs = 60000,
  dayMs = 86400000,
  timestampSlopMs = 999;

const scheduleCodec = Schema.fromJsonString(Schema.toCodecJson(WeeklySchedule));

export const activateWeekly = Effect.fn(function* (user: string, grant: string, now: number) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT u.time_zone,u.service_market,u.locale,s.snapshot_json FROM users u LEFT JOIN weekly_schedules s ON s.user_id=u.id WHERE u.id=${user}`;

  const context = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      time_zone: WeeklySchedule.fields.timeZone,
      service_market: WeeklySchedule.fields.serviceMarket,
      locale: WeeklySchedule.fields.locale,
      snapshot_json: Schema.OptionFromNullOr(scheduleCodec),
    })
  )(row);

  const selected = Option.match(context.snapshot_json, {
    onNone: () => ({
      id: newId(),
      version: 1,
      timing: { weekday: 0, hour: 18, minute: 0 },
      timeZone: context.time_zone,
      serviceMarket: context.service_market,
      locale: context.locale,
    }),
    onSome: (existing) => ({ ...existing, version: existing.version + 1 }),
  });

  const schedule = yield* Schema.decodeUnknownEffect(Schema.toType(WeeklySchedule))({
    ...selected,
    enabled: true,
    nextScheduledAt: nextWeeklyOccurrence({ ...selected, after: DateTime.makeUnsafe(now) }),
  });

  const encoded = yield* Schema.encodeEffect(scheduleCodec)(schedule);
  yield* sql`INSERT INTO weekly_schedules(user_id,id,revision,grant_id,snapshot_json,next_ms) VALUES(${user},${schedule.id},${schedule.version},${grant},${encoded},${schedule.nextScheduledAt.epochMilliseconds}) ON CONFLICT(user_id) DO UPDATE SET revision=excluded.revision,grant_id=excluded.grant_id,snapshot_json=excluded.snapshot_json,next_ms=excluded.next_ms`;

  return schedule.nextScheduledAt.epochMilliseconds;
});

export const weeklyQuestion = Effect.fn(function* (
  sender: WeeklyQuestionSender,
  id: string,
  active: boolean
) {
  const offer = WeeklyQuestionOffer.make({
    id: ConsentRecordId.make(id),
    disclosure: weeklyDisclosureFor(),
    acceptChoice: "weekly:" + id + ":accept",
    declineChoice: "weekly:" + id + (active ? ":revoke" : ":decline"),
  });

  const template = yield* sender.prepare(offer);

  return yield* Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({ offer: WeeklyQuestionOffer, parameter: Schema.String, text: Schema.String })
    )
  )({ ...template, offer });
});

const weeklyReady = Schema.Struct({ id: ConsentRecordId, user_id: UserId });

export const repairWeekly = Effect.fn(function* (now: number, storage: DurableObjectStorage) {
  const sql = yield* SqliteClient;

  const [row] =
    yield* sql`SELECT min(at) AS at FROM (SELECT attempt_ms AS at FROM reminder_disclosures WHERE state='ready' AND kind='weekly-summary' UNION ALL SELECT s.next_ms FROM weekly_schedules s JOIN proactive_grants g ON g.id=s.grant_id WHERE g.revoked_at_ms IS NULL AND NOT EXISTS(SELECT 1 FROM weekly_attention a WHERE a.grant_id=g.id AND (a.paused_ms IS NOT NULL OR (a.ask_ms IS NOT NULL AND a.question_delivered_ms IS NULL))) UNION ALL SELECT d.offer_ms FROM reminder_deliveries d JOIN proactive_grants g ON g.id=d.grant_id WHERE d.state='ready' AND g.kind='weekly-summary' UNION ALL SELECT min(expires_ms) FROM weekly_summary_reports UNION ALL SELECT min(ask_ms) FROM weekly_attention WHERE question_id IS NULL AND paused_ms IS NULL)`;

  const at = row?.at;

  return Predicate.isNumber(at) ? yield* preserveStoreAlarm(storage, Math.max(now, at)) : false;
});

export const offerWeeklyQuestions = Effect.fn(function* (
  now: number,
  storage: DurableObjectStorage,
  env: NativeReminderEnvironment
) {
  const sql = yield* SqliteClient;
  yield* sql`UPDATE reminder_disclosures SET state='expired' WHERE kind='weekly-summary' AND state='ready' AND expires_ms<=${now}`;

  const jobs = yield* Schema.decodeUnknownEffect(Schema.Array(weeklyReady))(
    yield* sql`UPDATE reminder_disclosures SET attempt_ms=min(expires_ms,${now + retryMs}) WHERE id IN(SELECT id FROM reminder_disclosures WHERE state='ready' AND kind='weekly-summary' AND attempt_ms<=${now} ORDER BY attempt_ms LIMIT 8) RETURNING id,user_id`
  );

  const sent = yield* Effect.forEach(jobs, (job) => {
    const queue = env.WEEKLY_DELIVERY_QUEUE;

    return queue === undefined
      ? Effect.succeed(false)
      : Effect.tryPromise(() =>
          queue.send({ kind: "weekly-question", version: 1, userId: job.user_id, id: job.id })
        ).pipe(Effect.result, Effect.map(Result.isSuccess));
  });

  const failed = sent.filter((delivered) => !delivered).length;

  yield* repairWeekly(now, storage);

  return { attempted: jobs.length, failed };
});

export type WeeklyLimits = Pick<
  NativeReminderEnvironment,
  "PROACTIVITY_ASK_AFTER" | "PROACTIVITY_PAUSE_AFTER"
>;

export const countWeekly = Effect.fn(function* (grant: string, at: number, env: WeeklyLimits) {
  const sql = yield* SqliteClient;

  const limits = yield* Schema.decodeEffect(WeeklyThresholdConfiguration)({
    askAfter: env.PROACTIVITY_ASK_AFTER ?? "4",
    pauseAfter: env.PROACTIVITY_PAUSE_AFTER ?? "2",
  });

  yield* sql`INSERT INTO weekly_attention(grant_id) VALUES(${grant}) ON CONFLICT DO NOTHING`;
  yield* sql`UPDATE weekly_attention SET unanswered=min(unanswered+1,200),
    ask_ms=CASE WHEN unanswered+1>=${limits.askAfter} AND NOT EXISTS(SELECT 1 FROM reminder_choices c JOIN reminder_disclosures o ON o.id=c.offer_id AND o.kind='weekly-summary' WHERE c.choice='decline') THEN coalesce(ask_ms,${at}) ELSE ask_ms END,
    paused_ms=CASE WHEN question_delivered_ms IS NOT NULL AND unanswered+1>=${limits.askAfter + limits.pauseAfter} THEN ${at} ELSE paused_ms END
    WHERE grant_id=${grant} AND paused_ms IS NULL AND ${at}>last_reply_ms AND (ask_ms IS NULL OR question_delivered_ms<${at})`;
});

export const prepareGovernorQuestion = Effect.fn(function* (
  sender: WeeklyQuestionSender,
  now: number
) {
  const sql = yield* SqliteClient;

  const [raw] =
    yield* sql`SELECT a.grant_id,a.ask_ms,g.user_id,c.portfolio,c.bsuid,c.endpoint FROM weekly_attention a JOIN proactive_grants g ON g.id=a.grant_id AND g.revoked_at_ms IS NULL JOIN reminder_channels c ON c.grant_id=g.id JOIN users u ON u.id=g.user_id AND u.whatsapp_portfolio_id=c.portfolio AND u.whatsapp_bsuid=c.bsuid WHERE a.question_id IS NULL AND a.ask_ms<=${now} AND a.paused_ms IS NULL AND NOT EXISTS(SELECT 1 FROM erasure_requests)`;

  if (raw === undefined) return;

  const held = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      grant_id: Schema.String,
      ask_ms: Schema.Int,
      user_id: UserId,
      portfolio: Schema.String,
      bsuid: Schema.String,
      endpoint: Schema.String,
    })
  )(raw);

  const id = newId(),
    body = yield* weeklyQuestion(sender, id, true),
    digest = Hex.encode(
      yield* digestBytes(
        new TextEncoder().encode(
          yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(body)
        )
      )
    );

  yield* sql`INSERT INTO reminder_disclosures(id,user_id,portfolio,bsuid,endpoint,request_message,created_ms,expires_ms,attempt_ms,correlation,disclosure,body,digest,grant_id,kind)
    VALUES(${id},${held.user_id},${held.portfolio},${held.bsuid},${held.endpoint},${"weekly-governor-" + id},${held.ask_ms},${held.ask_ms + dayMs},${now},${newId()},${yield* Schema.encodeEffect(Schema.fromJsonString(DisclosureSnapshot))(weeklyDisclosureFor())},${body},${digest},${held.grant_id},'weekly-summary')`;
  yield* sql`UPDATE weekly_attention SET question_id=${id} WHERE grant_id=${held.grant_id}`;
});

export const recordWeeklyReply = Effect.fn(function* (event: WhatsAppTurnAdmission) {
  if (Option.isNone(event.replyToMessageId)) return;
  const sql = yield* SqliteClient;
  yield* sql`UPDATE weekly_attention AS a SET unanswered=0,last_reply_ms=${event.occurredAtMs},ask_ms=NULL,question_id=NULL,question_delivered_ms=NULL WHERE a.paused_ms IS NULL AND a.last_reply_ms<${event.occurredAtMs} AND EXISTS(SELECT 1 FROM whatsapp_deliveries w JOIN proactive_grants g ON g.id=a.grant_id AND g.user_id=w.user_id AND g.revoked_at_ms IS NULL JOIN users u ON u.id=g.user_id AND u.whatsapp_portfolio_id=w.portfolio AND u.whatsapp_bsuid=w.bsuid WHERE w.user_id=${event.userId} AND w.portfolio=${event.portfolioId} AND w.bsuid=${event.bsuid} AND w.endpoint=${event.businessPhoneNumberId} AND w.provider_message_id=${event.replyToMessageId.value} AND w.state='delivered' AND w.delivered_at_ms>a.last_reply_ms AND w.delivered_at_ms<=${event.occurredAtMs + timestampSlopMs} AND ((w.family='disclosure' AND w.operation_id=a.question_id) OR (w.family='proactivity' AND EXISTS(SELECT 1 FROM reminder_deliveries d WHERE d.id=w.operation_id AND d.grant_id=a.grant_id))))`;
});
