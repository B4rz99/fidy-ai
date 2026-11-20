import type { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import type { UserStoreBindings } from "../directory/contract";
import { Context, Data, Effect, type Option, Schema } from "effect";
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
import type { QueryAuthority } from "../canonical-work/contract";
import type { CanonicalCapability } from "../../src/core/canonical-operations/contract";

const messageContext = {
  id: Schema.String.check(Schema.isUUID()),
  text: Schema.Option(TranscriptText),
  scheduledAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  timeZone: IanaTimeZone,
};

export const ProactivityReport = Schema.Union([
  Schema.TaggedStruct("GrantMessage", {
    ...messageContext,
    role: Schema.Literals([
      "budget-threshold",
      "manual-entry-reminder",
      "reminder-question",
      "new-recurring-series",
    ]),
    grantId: ConsentRecordId,
  }),
  Schema.TaggedStruct("ConsentOfferMessage", {
    ...messageContext,
    role: Schema.Literals(["budget-offer", "reminder-offer", "recurring-offer"]),
    offerId: ConsentRecordId,
  }),
]);
export type ProactivityReport = typeof ProactivityReport.Type;

export type ReminderCanonicalWork = Readonly<{
  db: D1Database;
  userId: string;
  authority: QueryAuthority;
  requiredScope: Option.Option<CanonicalCapability>;
  current: number;
}>;

const unansweredDeliveries = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 200 }));

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

export const WeeklyScheduleSnapshot = Schema.Struct({
  ...WeeklySchedule.fields,
  userId: UserId,
  consentGrantId: ConsentRecordId,
});
export type WeeklyScheduleSnapshot = typeof WeeklyScheduleSnapshot.Type;

export const ReminderScheduleSnapshot = Schema.Struct({
  ...ReminderSchedule.fields,
  userId: UserId,
  consentGrantId: ConsentRecordId,
});
export type ReminderScheduleSnapshot = typeof ReminderScheduleSnapshot.Type;

export type ReminderMaterialization =
  | Readonly<{ _tag: "NoWork" | "Expired" }>
  | Readonly<{ _tag: "Created"; id: InsightEventId }>;

export const DueWeeklySchedule = Schema.Struct({ userId: UserId, id: ScheduleId });
export type DueWeeklySchedule = typeof DueWeeklySchedule.Type;

export const WeeklySummaryReport = Schema.Struct({
  insightEventId: InsightEventId,
  payload: WeeklySummaryPayload,
  presentation: InsightTemplateSummary,
  expiresAt: UtcTimestamp,
  consentGrantId: ConsentRecordId,
}).annotate({ identifier: "WeeklySummaryReport" });
export type WeeklySummaryReport = typeof WeeklySummaryReport.Type;

export type WeeklyMaterialization =
  | Readonly<{ _tag: "NoWork" | "NoActivity" | "Expired" }>
  | Readonly<{ _tag: "Created"; id: InsightEventId }>;

export const WeeklySummaryWork = Schema.Struct({
  traceContext: Schema.optionalKey(Schema.Unknown),
  kind: Schema.Literal("weekly-summary"),
  version: Schema.Literal(1),
  userId: UserId,
  insightEventId: InsightEventId,
});
export type WeeklySummaryWork = typeof WeeklySummaryWork.Type;

export const WeeklyQuestionWork = Schema.Struct({
  traceContext: Schema.optionalKey(Schema.Unknown),
  kind: Schema.Literal("weekly-question"),
  version: Schema.Literal(1),
  userId: UserId,
  id: Schema.String.check(Schema.isUUID()),
});
export type WeeklyQuestionWork = typeof WeeklyQuestionWork.Type;

export const CategoryDeliveryWork = Schema.Struct({
  owner: Schema.optionalKey(Schema.Literal("user")),
  traceContext: Schema.optionalKey(Schema.Unknown),
  kind: Schema.Literal("proactivity-delivery"),
  version: Schema.Literal(1),
  userId: UserId,
  id: Schema.String.check(Schema.isUUID()),
});
export type CategoryDeliveryWork = typeof CategoryDeliveryWork.Type;

export const ProactivityDeliveryWork = Schema.Union([
  WeeklySummaryWork,
  WeeklyQuestionWork,
  CategoryDeliveryWork,
]);
export type ProactivityDeliveryWork = typeof ProactivityDeliveryWork.Type;

export const ProactivityWorkflowId = Schema.Union([
  Schema.TemplateLiteral([
    "weekly-",
    UserId,
    "-",
    Schema.Union([WeeklySummaryWork.fields.kind, WeeklyQuestionWork.fields.kind]),
    "-",
    WeeklyQuestionWork.fields.id,
  ]),
  Schema.TemplateLiteral(["proactivity-", UserId, "-", CategoryDeliveryWork.fields.id]),
]);

export const ProactivityWorkObservation = Schema.Struct({
  id: ProactivityWorkflowId,
  created: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  deadline: Schema.OptionFromNullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

export const proactivityObservationLimit = 8;
export const ProactivityWorkObservations = Schema.Array(ProactivityWorkObservation).check(
  Schema.isMaxLength(proactivityObservationLimit)
);
export type ProactivityWorkObservations = typeof ProactivityWorkObservations.Type;

export const ProactivityActivity = Schema.Union([
  ProactivityDeliveryWork,
  Schema.Struct({
    kind: Schema.Literal("proactivity-generate"),
    version: Schema.Literal(1),
    userId: UserId,
  }),
  Schema.Struct({
    kind: Schema.Literal("proactivity-recover"),
    version: Schema.Literal(1),
    userId: UserId,
    work: ProactivityDeliveryWork,
  }),
  Schema.Struct({
    kind: Schema.Literal("weekly-generate"),
    version: Schema.Literal(1),
    userId: UserId,
    id: ScheduleId,
  }),
]);
export type ProactivityActivity = typeof ProactivityActivity.Type;

export const ProactivityActivityResult = Schema.Union([
  Schema.TaggedStruct("Done", {}),
  Schema.TaggedStruct("RecoveryAdmitted", {}),
  Schema.TaggedStruct("Deferred", { nextEligibleAtMs: Schema.Int }),
]);
export type ProactivityActivityResult = typeof ProactivityActivityResult.Type;

export type ProactivityEnvironment = Partial<UserStoreBindings> &
  Readonly<{ DB: D1Database }> &
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

export const DueInsight = Schema.Struct({ userId: UserId, id: InsightEventId });
export type DueInsight = typeof DueInsight.Type;

export class ReminderRevisionConflict extends Data.TaggedError("ReminderRevisionConflict") {}

export class InsightUnavailable extends Data.TaggedError("InsightUnavailable") {}

export type RecurringDigestAdvanceResult =
  | Readonly<{ _tag: "NoWork" | "Progress" }>
  | Readonly<{ _tag: "Created"; id: InsightEventId }>;

export type NativeReminderEnvironment = UserStoreBindings &
  Pick<
    ProactivityEnvironment,
    | "KAPSO_API_KEY"
    | "PROACTIVITY_ENABLED"
    | "PROACTIVITY_TEMPLATE_JSON"
    | "WEEKLY_SUMMARY_ENABLED"
    | "WEEKLY_QUESTION_TEMPLATE_JSON"
    | "WEEKLY_SUMMARY_TEMPLATE_JSON"
    | "PROACTIVITY_ASK_AFTER"
    | "PROACTIVITY_PAUSE_AFTER"
  > &
  Partial<{ WEEKLY_DELIVERY_QUEUE: Pick<Queue<ProactivityDeliveryWork>, "send"> }>;

export const weeklyPauseMention =
  "Pausé tus resúmenes semanales porque no recibí respuesta. Puedes pedirme que los reactive.";
export const reminderPauseMention =
  "Pausé tus recordatorios de registro manual porque no recibí respuesta. Puedes pedirme que los reactive.";
export type PauseNoticeService = {
  bind: (
    turn: { id: string; user: string; session: string },
    newSession: boolean
  ) => Effect.Effect<void, InsightUnavailable, SqliteClient>;
  include: (
    turn: string,
    text: TranscriptText
  ) => Effect.Effect<TranscriptText, InsightUnavailable, SqliteClient>;
  acknowledge: (turn: string) => Effect.Effect<void, InsightUnavailable, SqliteClient>;
};
export const HostedPauseNotice = Context.Reference<PauseNoticeService>(
  "@fidy/server/cloudflare/insights/contract/HostedPauseNotice",
  {
    defaultValue: (): PauseNoticeService => ({
      bind: (): Effect.Effect<never, InsightUnavailable> => Effect.fail(new InsightUnavailable()),
      include: (): Effect.Effect<never, InsightUnavailable> =>
        Effect.fail(new InsightUnavailable()),
      acknowledge: (): Effect.Effect<never, InsightUnavailable> =>
        Effect.fail(new InsightUnavailable()),
    }),
  }
);
