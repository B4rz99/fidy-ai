import { Data, type DateTime, Schema } from "effect";
import { ConsentRecordId } from "../../src/core/consent/contract";
import {
  InsightEventId,
  ProactivityThresholds,
  ReminderSchedule,
  ScheduleId,
  WeeklySchedule,
} from "../../src/core/insights/contract";
import { UserId } from "../../src/core/identity/contract";
import { TranscriptText } from "../../src/core/agent/contract";
import { IanaTimeZone } from "../../src/core/_shared/context";
import { UtcTimestamp } from "../../src/core/_shared/time";
import { WeeklySummaryPayload } from "../../src/core/insights/weekly-summary/contract";
import { InsightTemplateSummary } from "../../src/shell/channels/whatsapp/contract";
import type { OwnedStatement } from "../../src/shell/owner-write/contract";
import type { QueryAuthority } from "../canonical-work/contract";
import type { CanonicalCapability } from "../../src/core/canonical-operations/contract";
import type { Option } from "effect";

const messageContext = {
  id: Schema.String.check(Schema.isUUID()),
  text: Schema.Option(TranscriptText),
  scheduledAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  timeZone: IanaTimeZone,
};
/** Frozen category content distinguishes existing delivery permission from a pending legal decision. */
export const ProactivityReport = Schema.Union([
  Schema.TaggedStruct("GrantMessage", {
    ...messageContext,
    role: Schema.Literals(["budget-threshold", "manual-entry-reminder", "reminder-question"]),
    grantId: ConsentRecordId,
  }),
  Schema.TaggedStruct("ConsentOfferMessage", {
    ...messageContext,
    role: Schema.Literals(["budget-offer", "reminder-offer"]),
    offerId: ConsentRecordId,
  }),
]);
export type ProactivityReport = typeof ProactivityReport.Type;

/** A caller-owned live authority held inside User coordination. The User is re-correlated at each read/write; neither this snapshot nor a schedule identity authorizes a later effect. */
export type ReminderCanonicalWork = Readonly<{
  db: D1Database;
  userId: string;
  authority: QueryAuthority;
  requiredScope: Option.Option<CanonicalCapability>;
  current: number;
}>;

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

/** Captured reminder instruction and exact legal grant, not reusable execution authority. */
export const ReminderScheduleSnapshot = Schema.Struct({
  ...ReminderSchedule.fields,
  userId: UserId,
  consentGrantId: ConsentRecordId,
});
export type ReminderScheduleSnapshot = typeof ReminderScheduleSnapshot.Type;

/** Reminder generation distinguishes no due work from expired unstarted delivery. */
export type ReminderMaterialization =
  | Readonly<{ _tag: "NoWork" | "Expired" }>
  | Readonly<{ _tag: "Created"; id: InsightEventId }>;

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
/** Content-free continuation for one frozen category message; the report owns its role and live grant. */
export const ProactivityDeliveryWork = Schema.Struct({
  kind: Schema.Literal("proactivity-delivery"),
  version: Schema.Literal(1),
  userId: UserId,
  id: Schema.String.check(Schema.isUUID()),
});
export type ProactivityDeliveryWork = typeof ProactivityDeliveryWork.Type;
export const WeeklyDeliveryWork = Schema.Union([
  WeeklySummaryWork,
  WeeklyQuestionWork,
  ProactivityDeliveryWork,
]);
export type WeeklyDeliveryWork = typeof WeeklyDeliveryWork.Type;
export const WeeklyActivity = Schema.Union([
  WeeklyDeliveryWork,
  Schema.Struct({
    kind: Schema.Literal("proactivity-generate"),
    version: Schema.Literal(1),
    userId: UserId,
  }),
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
      PROACTIVITY_ENABLED: string;
      PROACTIVITY_TEMPLATE_JSON: string;
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

/** Another instruction edit has already replaced the revision this caller read. */
export class ReminderRevisionConflict extends Data.TaggedError("ReminderRevisionConflict") {}

/** Insight state could not be read or retained completely; it is not an absent occurrence. */
export class InsightUnavailable extends Data.TaggedError("InsightUnavailable") {}
