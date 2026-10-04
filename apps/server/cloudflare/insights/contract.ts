import { Data, type DateTime, Schema } from "effect";
import { ConsentRecordId } from "../../src/core/consent/contract";
import { InsightEventId, ScheduleId, WeeklySchedule } from "../../src/core/insights/contract";
import { UserId } from "../../src/core/identity/contract";
import { UtcTimestamp } from "../../src/core/_shared/time";
import { WeeklySummaryPayload } from "../../src/core/insights/weekly-summary/contract";
import { InsightTemplateSummary } from "../../src/shell/channels/whatsapp/contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";

/** Historical instruction plus the explicit owner and particular delivery grant; never reusable authority. */
export const WeeklyScheduleSnapshot = Schema.Struct({
  ...WeeklySchedule.fields,
  userId: UserId,
  consentGrantId: ConsentRecordId,
});
export type WeeklyScheduleSnapshot = typeof WeeklyScheduleSnapshot.Type;

/** A bounded due identity is a coordination hint, not content or authority. */
export const DueWeeklySchedule = Schema.Struct({ userId: UserId, id: ScheduleId });
export type DueWeeklySchedule = typeof DueWeeklySchedule.Type;

/** Compose a caller-owned action ending at its WHERE condition with exact current schedule and Consent. */
export type WeeklyOccurrenceGuard = Readonly<{
  db: D1Database;
  snapshot: WeeklyScheduleSnapshot;
  now: DateTime.Utc;
  statement: OwnedStatement;
}>;

/** Advance only with the same materialized cutoff in the caller's occurrence/report/outbox unit. */
export type WeeklyScheduleAdvance = Omit<WeeklyOccurrenceGuard, "statement"> &
  Readonly<{ materializedScheduledAt: DateTime.Utc; outcome: "generated" | "empty" | "expired" }>;
/** Immutable complete report and presentation for one explicit occurrence; attention state remains Insights-owned. */
export const WeeklySummaryReport = Schema.Struct({
  insightEventId: InsightEventId,
  payload: WeeklySummaryPayload,
  presentation: InsightTemplateSummary,
  expiresAt: UtcTimestamp,
  consentGrantId: ConsentRecordId,
}).annotate({ identifier: "WeeklySummaryReport" });
export type WeeklySummaryReport = typeof WeeklySummaryReport.Type;

/** Closed materialization outcomes distinguish empty activity from unavailable projections and stale delivery work. */
export type WeeklyMaterialization =
  | Readonly<{ _tag: "NoWork" | "NoActivity" | "Expired" }>
  | Readonly<{ _tag: "Created"; id: InsightEventId }>;

/** Only identities cross Queue and Workflow history; neither financial facts nor authorization does. */
export const WeeklySummaryWork = Schema.Struct({
  kind: Schema.Literal("weekly-summary"),
  version: Schema.Literal(1),
  userId: UserId,
  insightEventId: InsightEventId,
});
export type WeeklySummaryWork = typeof WeeklySummaryWork.Type;

/** A coordination hint only; processing must re-read the event inside this User's boundary. */
export const DueInsight = Schema.Struct({ userId: UserId, id: InsightEventId });
export type DueInsight = typeof DueInsight.Type;

/** Insight state could not be read or retained completely; it is not an absent occurrence. */
export class InsightUnavailable extends Data.TaggedError("InsightUnavailable") {}
