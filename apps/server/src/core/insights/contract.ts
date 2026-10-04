import { Data, Schema, Struct } from "effect";
import { IanaTimeZone, Locale, ServiceMarket } from "~/core/_shared/context";
import { MoneyGroups } from "~/core/_shared/money";
import { ProviderMessageEvidence } from "~/core/provider-evidence/contract";
import { UtcTimestamp } from "~/core/_shared/time";

/** The four proactive decisions committed by the MVP specification. */
export const InsightKind = Schema.Literals([
  "budget-threshold",
  "new-recurring-series",
  "weekly-summary",
  "manual-entry-reminder",
]);
export type InsightKind = typeof InsightKind.Type;

/** Stable identity of one generated occurrence. */
export const InsightEventId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("InsightEventId"))
  .annotate({ identifier: "InsightEventId" });
export type InsightEventId = typeof InsightEventId.Type;

/** Stable identity of the schedule whose revision generated an occurrence. */
export const ScheduleId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("ScheduleId"))
  .annotate({ identifier: "ScheduleId" });
export type ScheduleId = typeof ScheduleId.Type;

/** Revisions start at one and increase whenever a Schedule's instructions change. */
export const ScheduleVersion = Schema.Int.check(Schema.isGreaterThan(0))
  .pipe(Schema.brand("ScheduleVersion"))
  .annotate({ identifier: "ScheduleVersion" });
export type ScheduleVersion = typeof ScheduleVersion.Type;

/** The forward-only attention lifecycle shared by every InsightEvent consumer. */
export const InsightLifecycleState = Schema.Literals(["pending", "delivered", "read", "dismissed"]);
export type InsightLifecycleState = typeof InsightLifecycleState.Type;

/**
 * One immutable generated occurrence plus its current lifecycle state. Context
 * is captured here rather than read from current User preferences later.
 */
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

/** Trusted generation facts; the operation supplies identity and starts lifecycle at pending. */
export const InsightGenerationInput = InsightEvent.mapFields(
  Struct.omit(["id", "lifecycleState"])
).annotate({ identifier: "InsightGenerationInput" });
export type InsightGenerationInput = typeof InsightGenerationInput.Type;

/** Stable identity of one append-only provider send record. */
export const DeliveryAttemptId = Schema.String.check(Schema.isUUID())
  .pipe(Schema.brand("DeliveryAttemptId"))
  .annotate({ identifier: "DeliveryAttemptId" });
export type DeliveryAttemptId = typeof DeliveryAttemptId.Type;

/** Evidence supplied after an external consumer actually attempted a send. */
export const InsightDeliveryAttempt = Schema.Struct({
  id: DeliveryAttemptId,
  insightEventId: InsightEventId,
  sentAt: UtcTimestamp,
  ...ProviderMessageEvidence.fields,
}).annotate({ identifier: "InsightDeliveryAttempt" });
export type InsightDeliveryAttempt = typeof InsightDeliveryAttempt.Type;

/** Provider evidence supplied by a consumer; ids are assigned from operation context. */
export const DeliveryEvidenceInput = InsightDeliveryAttempt.mapFields(
  Struct.omit(["id", "insightEventId"])
).annotate({ identifier: "DeliveryEvidenceInput" });
export type DeliveryEvidenceInput = typeof DeliveryEvidenceInput.Type;

/** The asked-for occurrence is absent from this User's InsightEvent stream. */
export class InsightNotFound extends Data.TaggedError("InsightNotFound")<{
  readonly insightEventId: InsightEventId;
}> {}

/** A requested lifecycle movement would move backward or repeat the current state. */
export class InvalidInsightTransition extends Data.TaggedError("InvalidInsightTransition")<{
  readonly current: InsightLifecycleState;
  readonly target: InsightLifecycleState;
  readonly allowedTargets: ReadonlyArray<InsightLifecycleState>;
}> {}

/** Every caller-actionable failure raised by the insights core. */
export type InsightFailure = InsightNotFound | InvalidInsightTransition;

/** A start-inclusive, end-exclusive financial reporting interval. */
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

/** Consecutive seven-local-day periods anchored to the original scheduled instant. */
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

/** Weekly wall-clock instructions; weekday uses Sunday=0 through Saturday=6. */
export const WeeklyTiming = Schema.Struct({
  weekday: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
  hour: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 })),
  minute: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 59 })),
}).annotate({ identifier: "WeeklyTiming" });
export type WeeklyTiming = typeof WeeklyTiming.Type;

/** One User-owned weekly instruction; execution advancement never changes its revision or retained reports. */
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

/** Temporal eligibility only; every Ready attempt still needs live Consent, identity and admission. */
export const InsightDeliveryDecision = Schema.Union([
  Schema.TaggedStruct("Ready", {}),
  Schema.TaggedStruct("Deferred", { nextEligibleAt: UtcTimestamp }),
  Schema.TaggedStruct("Expired", {}),
]).annotate({ identifier: "InsightDeliveryDecision" });
export type InsightDeliveryDecision = typeof InsightDeliveryDecision.Type;
