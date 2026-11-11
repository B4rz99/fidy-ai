import { preparePredicateCheck } from "../../../src/shell/sql-assertions/operations";
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
  preparePredicateCheck({
    db: input.db,
    scope: "insight_mutation",
    predicate: {
      sql: `SELECT 1 WHERE NOT EXISTS (
        SELECT 1 FROM insight_events AS e JOIN (${input.proof.sql}) AS v
          ON v.user_id=e.user_id AND v.insight_event_id=e.id
        WHERE e.user_id=? AND e.id=? AND e.delivery_receipt_id IS NOT NULL
          AND NOT (e.delivery_sent_at_ms IS v.send_started_at_ms
            AND e.delivery_channel IS 'whatsapp' AND e.delivery_provider IS 'kapso'
            AND e.delivery_provider_message_id IS v.provider_message_id))`,
      params: [...input.proof.params, input.userId, input.insightEventId],
    },
  }),
  ...prepareCount(input),
  input.db
    .prepare(`UPDATE insight_events SET
      delivery_receipt_id=coalesce(delivery_receipt_id,?),
      delivery_sent_at_ms=coalesce(delivery_sent_at_ms,v.send_started_at_ms),
      delivery_channel=coalesce(delivery_channel,'whatsapp'),
      delivery_provider=coalesce(delivery_provider,'kapso'),
      delivery_provider_message_id=coalesce(delivery_provider_message_id,v.provider_message_id),
      lifecycle_state=CASE WHEN lifecycle_state='pending' THEN 'delivered' ELSE lifecycle_state END
      FROM (${input.proof.sql}) AS v WHERE insight_events.user_id=? AND insight_events.id=?
      AND v.user_id=insight_events.user_id AND v.insight_event_id=insight_events.id
      AND (delivery_receipt_id IS NULL OR lifecycle_state='pending')`)
    .bind(
      DeliveryAttemptId.make(newId()),
      ...input.proof.params,
      input.userId,
      input.insightEventId
    ),
  input.db
    .prepare(
      `UPDATE proactive_messages SET dispatch_state='settled' WHERE dispatch_state IS NOT NULL AND kind='weekly-summary' AND user_id=? AND id=? AND dispatch_state <> 'settled' AND EXISTS (SELECT 1 FROM (${input.proof.sql}) AS v WHERE v.user_id=? AND v.insight_event_id=?)`
    )
    .bind(
      input.userId,
      input.insightEventId,
      ...input.proof.params,
      input.userId,
      input.insightEventId
    ),
];
