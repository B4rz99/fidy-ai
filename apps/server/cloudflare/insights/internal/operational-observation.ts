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
  const kinds = [
    ...(input.weeklyEnabled ? ["weekly-summary", "weekly-question"] : []),
    ...(input.proactivityEnabled ? ["proactivity-delivery"] : []),
  ];
  for (const kind of kinds) {
    if (kind === "weekly-question") {
      sources.push(
        `SELECT * FROM (SELECT user_id AS userId,'weekly-question' AS kind,NULL AS insightEventId,id,created_at_ms AS created,created_at_ms+86400000 AS deadline FROM weekly_question_requests INDEXED BY weekly_question_intents_health WHERE state='ready' ORDER BY created_at_ms,user_id,id LIMIT ${proactivityObservationLimit})`
      );
      continue;
    }
    sources.push(`SELECT * FROM (SELECT user_id AS userId,kind,
      CASE WHEN kind='weekly-summary' THEN proactive_messages.id END AS insightEventId,
      CASE WHEN kind<>'weekly-summary' THEN proactive_messages.id END AS id,
      dispatch_created_at_ms AS created,expires_at_ms AS deadline
      FROM proactive_messages INDEXED BY report_dispatch_health
      WHERE kind='${kind}' AND dispatch_state IN ('ready','started')
      ORDER BY dispatch_created_at_ms,user_id,proactive_messages.id LIMIT ${proactivityObservationLimit})`);
  }

  return input.db.prepare(
    sources.length === 0
      ? "SELECT NULL AS userId, NULL AS kind, 1 AS version, NULL AS insightEventId, NULL AS id, 0 AS created, NULL AS deadline WHERE 0"
      : `SELECT userId, kind, 1 AS version, insightEventId, id, created, deadline FROM (${sources.join(" UNION ALL ")}) ORDER BY created, userId, kind, id, insightEventId LIMIT ${proactivityObservationLimit}`
  );
};
