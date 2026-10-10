import { Schema } from "effect";
import {
  CategoryDeliveryWork,
  ProactivityWorkObservation,
  WeeklyQuestionWork,
  WeeklySummaryWork,
  proactivityObservationLimit,
} from "../contract";

const timing = {
  created: ProactivityWorkObservation.fields.created,
  deadline: ProactivityWorkObservation.fields.deadline,
};
export const PendingDeliveryObservations = Schema.Array(
  Schema.Union([
    Schema.Struct({ ...WeeklySummaryWork.fields, ...timing }),
    Schema.Struct({ ...WeeklyQuestionWork.fields, ...timing }),
    Schema.Struct({ ...CategoryDeliveryWork.fields, ...timing }),
  ])
).check(Schema.isMaxLength(proactivityObservationLimit));

/** Select bounded owner-private Work hints; locator construction stays outside SQL. */
export const prepareProactivityWorkObservation = (
  input: Readonly<{ db: D1Database; weeklyEnabled: boolean; proactivityEnabled: boolean }>
): D1PreparedStatement => {
  const sources: string[] = [];
  if (input.weeklyEnabled) {
    sources.push(`SELECT o.user_id AS userId, 'weekly-summary' AS kind, o.insight_event_id AS insightEventId, NULL AS id,
      o.created_at_ms AS created, r.expires_at_ms AS deadline
      FROM (SELECT user_id, insight_event_id, created_at_ms FROM weekly_summary_outbox
        WHERE state IN ('ready', 'started') ORDER BY created_at_ms, user_id, insight_event_id LIMIT ${proactivityObservationLimit}) o
      JOIN weekly_summary_reports r ON r.user_id=o.user_id AND r.insight_event_id=o.insight_event_id`);
    sources.push(`SELECT user_id AS userId, 'weekly-question' AS kind, NULL AS insightEventId, id,
      created_at_ms AS created, created_at_ms+86400000 AS deadline
      FROM (SELECT user_id, id, created_at_ms FROM weekly_question_intents
        WHERE state='ready' ORDER BY created_at_ms, user_id, id LIMIT ${proactivityObservationLimit})`);
  }
  if (input.proactivityEnabled) {
    sources.push(`SELECT o.user_id AS userId, 'proactivity-delivery' AS kind, NULL AS insightEventId, o.delivery_id AS id,
      o.created_at_ms AS created, r.expires_at_ms AS deadline
      FROM (SELECT user_id, delivery_id, created_at_ms FROM proactivity_outbox
        WHERE state IN ('ready', 'started') ORDER BY created_at_ms, user_id, delivery_id LIMIT ${proactivityObservationLimit}) o
      JOIN proactivity_reports r ON r.user_id=o.user_id AND r.delivery_id=o.delivery_id`);
  }
  return input.db.prepare(
    sources.length === 0
      ? "SELECT NULL AS userId, NULL AS kind, 1 AS version, NULL AS insightEventId, NULL AS id, 0 AS created, NULL AS deadline WHERE 0"
      : `SELECT userId, kind, 1 AS version, insightEventId, id, created, deadline FROM (${sources.join(" UNION ALL ")}) ORDER BY created, userId, kind, id, insightEventId LIMIT ${proactivityObservationLimit}`
  );
};
