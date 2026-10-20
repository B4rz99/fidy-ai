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
    sources.push(`SELECT * FROM (SELECT user_id AS userId,kind,
      CASE WHEN kind='weekly-summary' THEN delivery_id END AS insightEventId,
      CASE WHEN kind<>'weekly-summary' THEN delivery_id END AS id,
      dispatch_created_at_ms AS created,CASE WHEN kind='weekly-question' THEN created_at_ms+86400000 ELSE expires_at_ms END AS deadline
      FROM insight_reports INDEXED BY report_dispatch_health
      WHERE kind='${kind}' AND dispatch_state IN ('ready','started')
      ORDER BY dispatch_created_at_ms,user_id,delivery_id LIMIT ${proactivityObservationLimit})`);
  }

  return input.db.prepare(
    sources.length === 0
      ? "SELECT NULL AS userId, NULL AS kind, 1 AS version, NULL AS insightEventId, NULL AS id, 0 AS created, NULL AS deadline WHERE 0"
      : `SELECT userId, kind, 1 AS version, insightEventId, id, created, deadline FROM (${sources.join(" UNION ALL ")}) ORDER BY created, userId, kind, id, insightEventId LIMIT ${proactivityObservationLimit}`
  );
};
