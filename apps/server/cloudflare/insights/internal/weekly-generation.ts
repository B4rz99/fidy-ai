import { type UserId } from "../../../src/core/identity/contract";
import { type InsightEventId } from "../../../src/core/insights/contract";
import { type OwnedStatement } from "../../../src/shell/owner-write/contract";

export const weeklyReportDeliveryQuery = (
  input: Readonly<{ userId: UserId; insightEventId: InsightEventId }>
): OwnedStatement => ({
  sql: `SELECT 1 FROM proactive_messages AS r JOIN insight_events AS e ON e.id=r.id AND e.user_id=r.user_id JOIN schedules AS s ON s.kind='weekly' AND s.id=e.schedule_id AND s.user_id=e.user_id WHERE r.kind='weekly-summary' AND r.user_id=? AND r.id=? AND s.enabled=1 AND s.consent_grant_id=r.consent_grant_id AND NOT EXISTS (SELECT 1 FROM weekly_proactivity_state AS g WHERE g.user_id=s.user_id AND (g.paused_at_ms IS NOT NULL OR (g.question_needed=1 AND g.question_delivered=0)))`,
  params: [input.userId, input.insightEventId],
});
