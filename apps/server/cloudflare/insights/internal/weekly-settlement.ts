import { type UserId } from "../../../src/core/identity/contract";
import {
  DeliveryAttemptId,
  type InsightEventId,
  type ProactivityThresholds,
} from "../../../src/core/insights/contract";
import { prepareCount } from "./weekly-governor";
import { insightVerifiedDeliveryQuery } from "../../whatsapp/operations";
import { newId } from "../../secret-material/operations";

/** Compose verified actual channel metadata with attention and execution; delivered never replaces read or dismissed. Execute this ordered group contiguously in the caller's native batch with Transcript effects: changes() couples the count marker to its governor update. */
export const prepareWeeklyDeliverySettlement = (
  input: Readonly<{
    db: D1Database;
    userId: UserId;
    insightEventId: InsightEventId;
    thresholds: ProactivityThresholds;
  }>
): ReadonlyArray<D1PreparedStatement> => {
  const proof = insightVerifiedDeliveryQuery(input);
  return [
    ...prepareCount({ ...input, proof }),
    input.db
      .prepare(`UPDATE insight_events SET
      delivery_receipt_id=coalesce(delivery_receipt_id,?),
      delivery_sent_at_ms=coalesce(delivery_sent_at_ms,v.send_started_at_ms),
      delivery_channel=coalesce(delivery_channel,'whatsapp'),
      delivery_provider=coalesce(delivery_provider,'kapso'),
      delivery_provider_message_id=coalesce(delivery_provider_message_id,v.provider_message_id),
      lifecycle_state=CASE WHEN lifecycle_state='pending' THEN 'delivered' ELSE lifecycle_state END
      FROM (${proof.sql}) AS v WHERE insight_events.user_id=? AND insight_events.id=?
      AND v.user_id=insight_events.user_id AND v.insight_event_id=insight_events.id
      AND (delivery_receipt_id IS NULL OR lifecycle_state='pending')`)
      .bind(DeliveryAttemptId.make(newId()), ...proof.params, input.userId, input.insightEventId),
    input.db
      .prepare(
        `UPDATE proactive_messages SET dispatch_state='settled' WHERE dispatch_state IS NOT NULL AND kind='weekly-summary' AND user_id=? AND id=? AND dispatch_state <> 'settled' AND EXISTS (SELECT 1 FROM (${proof.sql}) AS v WHERE v.user_id=? AND v.insight_event_id=?)`
      )
      .bind(
        input.userId,
        input.insightEventId,
        ...proof.params,
        input.userId,
        input.insightEventId
      ),
  ];
};
