import { Data, DateTime, Option, Schema, Struct } from "effect";
import { RecurringSeriesConfirmed } from "~/core/recurring/contract";
import { IanaTimeZone, Locale, ServiceMarket } from "~/core/_shared/context";
import { MoneyGroups, type ReadonlyMoney } from "~/core/_shared/money";
import { ProviderMessageEvidence } from "~/core/provider-evidence/contract";
import { UtcTimestamp } from "~/core/_shared/time";

export const InsightKind = Schema.Literals([
  "budget-threshold",
  "new-recurring-series",
  "weekly-summary",
  "manual-entry-reminder",
]);

export type InsightKind = typeof InsightKind.Type;

export const ProactivityThresholds = Schema.Struct({
  askAfter: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  pauseAfter: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
});

export type ProactivityThresholds = typeof ProactivityThresholds.Type;

export const InsightEventId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("InsightEventId"))
  .annotate({ identifier: "InsightEventId" });

export type InsightEventId = typeof InsightEventId.Type;

export const ScheduleId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("ScheduleId"))
  .annotate({ identifier: "ScheduleId" });

export type ScheduleId = typeof ScheduleId.Type;

export const ScheduleVersion = Schema.Int.check(Schema.isGreaterThan(0))
  .pipe(Schema.brand("ScheduleVersion"))
  .annotate({ identifier: "ScheduleVersion" });

export type ScheduleVersion = typeof ScheduleVersion.Type;

export const ProactivityMessageRole = Schema.Literals([
  "budget-threshold",
  "manual-entry-reminder",
  "budget-offer",
  "recurring-offer",
  "reminder-offer",
  "reminder-question",
  "new-recurring-series",
]);

export type ProactivityMessageRole = typeof ProactivityMessageRole.Type;

export const InsightLifecycleState = Schema.Literals(["pending", "delivered", "read", "dismissed"]);

export type InsightLifecycleState = typeof InsightLifecycleState.Type;

export const InsightEvent = Schema.Struct({
  id: InsightEventId,
  kind: InsightKind,
  scheduleId: ScheduleId,
  scheduleVersion: ScheduleVersion,
  serviceMarket: ServiceMarket,
  locale: Locale,
  timeZone: IanaTimeZone,
  scheduledAt: UtcTimestamp,
  moneyGroups: MoneyGroups,
  lifecycleState: InsightLifecycleState,
}).annotate({ identifier: "InsightEvent" });

export type InsightEvent = typeof InsightEvent.Type;

export const InsightGenerationInput = InsightEvent.mapFields(
  Struct.omit(["id", "lifecycleState"])
).annotate({ identifier: "InsightGenerationInput" });

export type InsightGenerationInput = typeof InsightGenerationInput.Type;

export const DeliveryAttemptId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("DeliveryAttemptId"))
  .annotate({ identifier: "DeliveryAttemptId" });

export type DeliveryAttemptId = typeof DeliveryAttemptId.Type;

export const InsightDeliveryAttempt = Schema.Struct({
  id: DeliveryAttemptId,
  insightEventId: InsightEventId,
  sentAt: UtcTimestamp,
  ...ProviderMessageEvidence.fields,
}).annotate({ identifier: "InsightDeliveryAttempt" });

export type InsightDeliveryAttempt = typeof InsightDeliveryAttempt.Type;

export const DeliveryEvidenceInput = InsightDeliveryAttempt.mapFields(
  Struct.omit(["id", "insightEventId"])
).annotate({ identifier: "DeliveryEvidenceInput" });

export type DeliveryEvidenceInput = typeof DeliveryEvidenceInput.Type;

export class InsightNotFound extends Data.TaggedError("InsightNotFound")<{
  readonly insightEventId: InsightEventId;
}> {}

export class InvalidInsightTransition extends Data.TaggedError("InvalidInsightTransition")<{
  readonly current: InsightLifecycleState;
  readonly target: InsightLifecycleState;
  readonly allowedTargets: ReadonlyArray<InsightLifecycleState>;
}> {}

export type InsightFailure = InsightNotFound | InvalidInsightTransition;

export const InsightPeriod = Schema.Struct({
  from: UtcTimestamp,
  toExclusive: UtcTimestamp,
})
  .check(
    Schema.makeFilter((period) =>
      period.from.epochMilliseconds < period.toExclusive.epochMilliseconds
        ? undefined
        : "Expected a non-empty reporting interval"
    )
  )
  .annotate({ identifier: "InsightPeriod" });

export type InsightPeriod = typeof InsightPeriod.Type;

export const WeeklyPeriods = Schema.Struct({
  current: InsightPeriod,
  previous: InsightPeriod,
})
  .check(
    Schema.makeFilter((periods) =>
      periods.previous.toExclusive.epochMilliseconds === periods.current.from.epochMilliseconds
        ? undefined
        : "Expected adjacent reporting periods"
    )
  )
  .annotate({ identifier: "WeeklyPeriods" });

export type WeeklyPeriods = typeof WeeklyPeriods.Type;

export const WeeklyTiming = Schema.Struct({
  weekday: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
  hour: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 })),
  minute: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 59 })),
}).annotate({ identifier: "WeeklyTiming" });

export type WeeklyTiming = typeof WeeklyTiming.Type;

export const WeeklySchedule = Schema.Struct({
  id: ScheduleId,
  version: ScheduleVersion,
  enabled: Schema.Boolean,
  timing: WeeklyTiming,
  timeZone: IanaTimeZone,
  serviceMarket: ServiceMarket,
  locale: Locale,
  nextScheduledAt: UtcTimestamp,
}).annotate({ identifier: "WeeklySchedule" });

export type WeeklySchedule = typeof WeeklySchedule.Type;

export const ReminderAnchorDate = Schema.String.check(
  Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u),
  Schema.makeFilter((value) => {
    const date = DateTime.make(value);

    return Option.isSome(date) && DateTime.formatIsoDateUtc(date.value) === value
      ? undefined
      : "Expected a real local calendar date";
  })
).annotate({ identifier: "ReminderAnchorDate" });

export type ReminderAnchorDate = typeof ReminderAnchorDate.Type;

export const ConfirmationDay = Schema.Struct({
  localDate: ReminderAnchorDate,
  timeZone: IanaTimeZone,
  from: UtcTimestamp,
  toExclusive: UtcTimestamp,
})
  .check(
    Schema.makeFilter((day) => {
      const start = DateTime.startOf(DateTime.setZoneNamedUnsafe(day.from, day.timeZone), "day");

      return (
        DateTime.formatIsoDate(start) === day.localDate &&
        start.epochMilliseconds === day.from.epochMilliseconds &&
        DateTime.add(start, { days: 1 }).epochMilliseconds === day.toExclusive.epochMilliseconds
      );
    })
  )
  .annotate({ identifier: "ConfirmationDay" });

export type ConfirmationDay = typeof ConfirmationDay.Type;

export const RecurringDigestItem = Schema.Struct({
  confirmationId: RecurringSeriesConfirmed.fields.id,
  seriesId: RecurringSeriesConfirmed.fields.seriesId,
  counterparty: RecurringSeriesConfirmed.fields.counterparty,
  money: RecurringSeriesConfirmed.fields.money,
  cadence: RecurringSeriesConfirmed.fields.cadence,
  confirmedAt: RecurringSeriesConfirmed.fields.confirmedAt,
}).annotate({ identifier: "RecurringDigestItem" });

export type RecurringDigestItem = typeof RecurringDigestItem.Type;

type DigestItemView = Omit<RecurringDigestItem, "money"> & Readonly<{ money: ReadonlyMoney }>;

const digestItemPrecedes = (previous: DigestItemView, item: DigestItemView): boolean => {
  if (previous.money.currency !== item.money.currency) {
    return previous.money.currency < item.money.currency;
  }

  if (previous.counterparty !== item.counterparty) return previous.counterparty < item.counterparty;

  return previous.confirmationId < item.confirmationId;
};

export const RecurringDigestPayload = Schema.Struct({
  confirmationDay: ConfirmationDay,
  items: Schema.NonEmptyArray(RecurringDigestItem),
})
  .check(
    Schema.makeFilter<
      Readonly<{ confirmationDay: ConfirmationDay; items: ReadonlyArray<DigestItemView> }>
    >((payload) => {
      const ids = new Set<string>();

      return payload.items.every((item: DigestItemView, index) => {
        if (ids.has(item.confirmationId)) return false;
        ids.add(item.confirmationId);

        if (
          item.confirmedAt.epochMilliseconds < payload.confirmationDay.from.epochMilliseconds ||
          item.confirmedAt.epochMilliseconds >=
            payload.confirmationDay.toExclusive.epochMilliseconds
        ) {
          return false;
        }

        const previous = payload.items[index - 1];

        return previous === undefined || digestItemPrecedes(previous, item);
      });
    })
  )
  .annotate({ identifier: "RecurringDigestPayload" });

export type RecurringDigestPayload = typeof RecurringDigestPayload.Type;

export const RecurringDigestReport = Schema.Struct({
  insightEventId: InsightEventId,
  serviceMarket: ServiceMarket,
  locale: Locale,
  scheduledAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  payload: RecurringDigestPayload,
}).annotate({ identifier: "RecurringDigestReport" });

export type RecurringDigestReport = typeof RecurringDigestReport.Type;

export const ReminderCadence = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("daily") }),
  Schema.Struct({ kind: Schema.Literal("weekdays") }),
  Schema.Struct({ kind: Schema.Literal("every-three-days"), anchorDate: ReminderAnchorDate }),
  Schema.Struct({ kind: Schema.Literal("weekly"), weekday: WeeklyTiming.fields.weekday }),
]).annotate({ identifier: "ReminderCadence" });

export type ReminderCadence = typeof ReminderCadence.Type;

export const ReminderTiming = Schema.Struct({
  hour: WeeklyTiming.fields.hour,
  minute: WeeklyTiming.fields.minute,
}).annotate({ identifier: "ReminderTiming" });

export type ReminderTiming = typeof ReminderTiming.Type;

export const ReminderSchedule = Schema.Struct({
  id: ScheduleId,
  version: ScheduleVersion,
  enabled: Schema.Boolean,
  cadence: ReminderCadence,
  timing: ReminderTiming,
  timeZone: IanaTimeZone,
  serviceMarket: ServiceMarket,
  locale: Locale,
  nextScheduledAt: UtcTimestamp,
}).annotate({ identifier: "ReminderSchedule" });

export type ReminderSchedule = typeof ReminderSchedule.Type;

export const ReminderScheduleEdit = Schema.Struct({
  expectedVersion: ScheduleVersion,
  cadence: ReminderCadence,
  timing: ReminderTiming,
  timeZone: IanaTimeZone,
}).annotate({ identifier: "ReminderScheduleEdit" });

export type ReminderScheduleEdit = typeof ReminderScheduleEdit.Type;

const reminderPauseAfter = 5;

export const ReminderStanding = Schema.Union([
  Schema.TaggedStruct("Attentive", { unanswered: Schema.Literals([0, 1, 2]) }),
  Schema.TaggedStruct("QuestionPending", { unanswered: Schema.Literal(3) }),
  Schema.TaggedStruct("QuestionDelivered", { unanswered: Schema.Literals([3, 4]) }),
  Schema.TaggedStruct("Paused", {
    unanswered: Schema.Literal(reminderPauseAfter),
    pausedAt: UtcTimestamp,
  }),
]).annotate({ identifier: "ReminderStanding" });

export type ReminderStanding = typeof ReminderStanding.Type;

export const InsightDeliveryDecision = Schema.Union([
  Schema.TaggedStruct("Ready", {}),
  Schema.TaggedStruct("Deferred", { nextEligibleAt: UtcTimestamp }),
  Schema.TaggedStruct("Expired", {}),
]).annotate({ identifier: "InsightDeliveryDecision" });

export type InsightDeliveryDecision = typeof InsightDeliveryDecision.Type;

export const RecurringDigestReportParams = Schema.Struct({ id: InsightEventId });
