import { countDeliveredReminder } from "./local-reminder-attention";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { Clock, DateTime, Effect, Schema } from "effect";
import { type DeliverySend } from "../../whatsapp/contract";
import { decideInsightDelivery } from "../../../src/core/insights/operations";
import {
  DeliveryAttemptId,
  InsightDeliveryAttempt,
  InsightEvent,
} from "../../../src/core/insights/contract";
import {
  ProactiveInsightTranscriptEntry,
  TranscriptEntryId,
} from "../../../src/core/agent/contract";
import { PreparedProactivityTemplate } from "../../../src/shell/channels/whatsapp/contract";
import { chargeLocalProvider } from "../../resource-admission/operations";
import { newId } from "../../secret-material/operations";

type Work = typeof DeliverySend.Type;
/** Atomically consumed with the channel's irreversible send claim, after the shared spend grant. */
export const claimPurpose = Effect.fn(function* (work: Work, enabled: boolean) {
  if (!enabled) return false;
  const now = yield* Clock.currentTimeMillis,
    sql = yield* SqliteClient;
  const [held] =
    yield* sql`SELECT e.event_json FROM reminder_deliveries d JOIN insight_events e ON e.id=d.id AND e.user_id=d.user_id
   JOIN proactive_grants g ON g.id=d.grant_id AND g.user_id=d.user_id AND g.kind='manual-entry-reminder' AND g.revoked_at_ms IS NULL
   WHERE d.id=${work.operationId} AND d.user_id=${work.userId} AND NOT EXISTS(SELECT 1 FROM reminder_attention a WHERE a.grant_id=d.grant_id AND (a.unanswered=5 OR (a.unanswered=3 AND a.question_delivered_ms IS NULL))) AND d.state='ready' AND d.spend_ready=1 AND d.correlation=${work.correlation} AND d.deadline_ms=${work.deadline} AND d.deadline_ms>${now}
   AND d.portfolio=${work.portfolio} AND d.bsuid=${work.bsuid} AND d.endpoint=${work.endpoint} AND d.digest=${work.contentDigest} AND ${work.sandboxPhone} IS NULL`;
  if (held === undefined || work.deadline === null) return false;
  const event = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.toCodecJson(InsightEvent))
  )(held.event_json);
  if (
    event.lifecycleState !== "pending" ||
    decideInsightDelivery({
      scheduledAt: event.scheduledAt,
      expiresAt: DateTime.makeUnsafe(work.deadline),
      timeZone: event.timeZone,
      now: DateTime.makeUnsafe(now),
    })._tag !== "Ready"
  ) {
    return false;
  }
  if (!(yield* chargeLocalProvider({ phase: "reminderSend", units: 4096 }, "user", now))) {
    return false;
  }
  const changed =
    yield* sql`UPDATE reminder_deliveries SET state='claimed' WHERE user_id=${work.userId} AND id=${work.operationId} AND state='ready' RETURNING id`;
  return changed.length === 1;
});
export const reconcileReceipt = Effect.fn(function* (user: string, id: string) {
  const sql = yield* SqliteClient;
  const [row] =
    yield* sql`SELECT w.provider_message_id,w.started_ms,w.delivered_at_ms,d.body,e.event_json,e.receipt_json FROM reminder_deliveries d JOIN whatsapp_deliveries w ON w.user_id=d.user_id AND w.operation_id=d.id AND w.family='proactivity' AND w.correlation=d.correlation JOIN insight_events e ON e.id=d.id AND e.user_id=d.user_id WHERE d.user_id=${user} AND d.id=${id} AND d.state='claimed' AND w.state='delivered' AND NOT EXISTS(SELECT 1 FROM erasure_requests WHERE user_id=d.user_id)`;
  if (row === undefined) return;
  const event = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.toCodecJson(InsightEvent))
  )(row.event_json);
  const seen = yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      provider_message_id: Schema.String,
      started_ms: Schema.Int,
      delivered_at_ms: Schema.Int,
      body: Schema.fromJsonString(PreparedProactivityTemplate),
    })
  )(row);
  if (row.receipt_json !== null) {
    const prior = yield* Schema.decodeUnknownEffect(
      Schema.fromJsonString(Schema.toCodecJson(InsightDeliveryAttempt))
    )(row.receipt_json);
    if (
      prior.providerMessageId !== seen.provider_message_id ||
      prior.channel !== "whatsapp" ||
      prior.provider !== "kapso"
    ) {
      return;
    }
  }
  const receipt = {
    id: DeliveryAttemptId.make(newId()),
    insightEventId: event.id,
    sentAt: DateTime.makeUnsafe(seen.started_ms),
    channel: "whatsapp",
    provider: "kapso",
    providerMessageId: seen.provider_message_id,
  };
  const bytes = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.toCodecJson(InsightDeliveryAttempt))
  )(receipt);
  yield* sql`UPDATE insight_events SET receipt_json=${bytes},event_json=CASE WHEN json_extract(event_json,'$.lifecycleState')='pending' THEN json_set(event_json,'$.lifecycleState','delivered') ELSE event_json END WHERE user_id=${user} AND id=${id} AND receipt_json IS NULL`;
  const retained = yield* Schema.encodeEffect(
    Schema.fromJsonString(Schema.toCodecJson(ProactiveInsightTranscriptEntry))
  )({
    _tag: "ProactiveInsightTranscriptEntry",
    id: TranscriptEntryId.make(newId()),
    insightEventId: event.id,
    occurredAt: DateTime.makeUnsafe(seen.delivered_at_ms),
    text: seen.body.text,
  });
  const inserted =
    yield* sql`INSERT INTO proactive_transcript VALUES(${id},${user},${seen.delivered_at_ms},${retained}) ON CONFLICT(id) DO NOTHING RETURNING id`;
  if (inserted.length === 1) yield* countDeliveredReminder(user, id, seen.delivered_at_ms);
});
