import { type UserId } from "../../../src/core/identity/contract";
import {
  DeliveryAttemptId,
  type InsightEventId,
  type ProactivityThresholds,
} from "../../../src/core/insights/contract";
import { prepareCount } from "./weekly-governor";
import { type OwnedStatement } from "../../../src/shell/owner-write/contract";
import { newId } from "../../secret-material/operations";

/** Compose verified actual channel metadata with attention and execution; delivered never replaces read or dismissed. The channel's published metadata query supplies actual send time and provider identity, not caller-proposed evidence. */
export const prepareWeeklyDeliverySettlement = (
  input: Readonly<{
    db: D1Database;
    userId: UserId;
    insightEventId: InsightEventId;
    proof: OwnedStatement;
    thresholds: ProactivityThresholds;
  }>
): ReadonlyArray<D1PreparedStatement> => [
  ...prepareCount(input),
  input.db
    .prepare(`INSERT INTO insight_delivery_attempts(id,user_id,insight_event_id,sent_at,channel,provider,provider_message_id)
 SELECT ?,v.user_id,v.insight_event_id,strftime('%Y-%m-%dT%H:%M:%fZ',v.send_started_at_ms / 1000.0,'unixepoch'),'whatsapp','kapso',v.provider_message_id FROM (${input.proof.sql}) AS v
 WHERE v.user_id=? AND v.insight_event_id=? AND NOT EXISTS (SELECT 1 FROM insight_delivery_attempts WHERE user_id=? AND insight_event_id=?)`)
    .bind(
      DeliveryAttemptId.make(newId()),
      ...input.proof.params,
      input.userId,
      input.insightEventId,
      input.userId,
      input.insightEventId
    ),
  input.db
    .prepare(
      `UPDATE insight_events SET lifecycle_state='delivered' WHERE user_id=? AND id=? AND lifecycle_state='pending' AND EXISTS (SELECT 1 FROM (${input.proof.sql}) AS v WHERE v.user_id=? AND v.insight_event_id=?)`
    )
    .bind(
      input.userId,
      input.insightEventId,
      ...input.proof.params,
      input.userId,
      input.insightEventId
    ),
  input.db
    .prepare(
      `UPDATE weekly_summary_outbox SET state='settled' WHERE user_id=? AND insight_event_id=? AND state <> 'settled' AND EXISTS (SELECT 1 FROM (${input.proof.sql}) AS v WHERE v.user_id=? AND v.insight_event_id=?)`
    )
    .bind(
      input.userId,
      input.insightEventId,
      ...input.proof.params,
      input.userId,
      input.insightEventId
    ),
];
