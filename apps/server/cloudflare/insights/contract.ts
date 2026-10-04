import { Data, type DateTime, Schema } from "effect";
import { ConsentRecordId } from "../../src/core/consent/contract";
import {
  InsightEventId,
  ProactivityThresholds,
  ScheduleId,
  WeeklySchedule,
} from "../../src/core/insights/contract";
import { UserId } from "../../src/core/identity/contract";
import { UtcTimestamp } from "../../src/core/_shared/time";
import { WeeklySummaryPayload } from "../../src/core/insights/weekly-summary/contract";
import { InsightTemplateSummary } from "../../src/shell/channels/whatsapp/contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";

const unansweredDeliveries = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 200 }));
/** Governor standing is separate from legal permission. Paused execution has no pending question. */
export const WeeklyGovernor = Schema.Union([
  Schema.TaggedStruct("Attentive", { unanswered: unansweredDeliveries }),
  Schema.TaggedStruct("QuestionPending", { unanswered: unansweredDeliveries }),
  Schema.TaggedStruct("QuestionDelivered", { unanswered: unansweredDeliveries }),
  Schema.TaggedStruct("Paused", {
    unanswered: unansweredDeliveries,
    pausedAt: UtcTimestamp,
  }),
]);
export type WeeklyGovernor = typeof WeeklyGovernor.Type;

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

/** Separate question identity; a question is not a financial InsightEvent or a counted delivery. */
export const WeeklyQuestionWork = Schema.Struct({
  kind: Schema.Literal("weekly-question"),
  version: Schema.Literal(1),
  userId: UserId,
  id: Schema.String.check(Schema.isUUID()),
});
export type WeeklyQuestionWork = typeof WeeklyQuestionWork.Type;
export const WeeklyDeliveryWork = Schema.Union([WeeklySummaryWork, WeeklyQuestionWork]);
export type WeeklyDeliveryWork = typeof WeeklyDeliveryWork.Type;
export const WeeklyActivity = Schema.Union([
  WeeklyDeliveryWork,
  Schema.Struct({
    kind: Schema.Literal("weekly-recover"),
    version: Schema.Literal(1),
    userId: UserId,
    work: WeeklyDeliveryWork,
  }),
  Schema.Struct({
    kind: Schema.Literal("weekly-generate"),
    version: Schema.Literal(1),
    userId: UserId,
    id: ScheduleId,
  }),
]);
export type WeeklyActivity = typeof WeeklyActivity.Type;
/** Workflow history retains only the next permissible instant, never provider/report/recipient text. */
export const WeeklyActivityResult = Schema.Union([
  Schema.TaggedStruct("Done", {}),
  Schema.TaggedStruct("RecoveryAdmitted", {}),
  Schema.TaggedStruct("Deferred", { nextEligibleAtMs: Schema.Int }),
]);
export type WeeklyActivityResult = typeof WeeklyActivityResult.Type;
/** Both approved templates and an explicit enablement gate are required before native execution. */
export type WeeklyEnvironment = Readonly<{ DB: D1Database }> &
  Partial<
    Readonly<{
      WEEKLY_SUMMARY_ENABLED: string;
      WEEKLY_SUMMARY_TEMPLATE_JSON: string;
      WEEKLY_QUESTION_TEMPLATE_JSON: string;
      PROACTIVITY_ASK_AFTER: string;
      PROACTIVITY_PAUSE_AFTER: string;
      KAPSO_API_KEY: string;
    }>
  >;
export const WeeklyThresholdConfiguration = Schema.toCodecStringTree(ProactivityThresholds);

/** A coordination hint only; processing must re-read the event inside this User's boundary. */
export const DueInsight = Schema.Struct({ userId: UserId, id: InsightEventId });
export type DueInsight = typeof DueInsight.Type;

/** Insight state could not be read or retained completely; it is not an absent occurrence. */
export class InsightUnavailable extends Data.TaggedError("InsightUnavailable") {}
