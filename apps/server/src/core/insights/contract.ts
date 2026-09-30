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

/** Every caller-actionable failure raised by the Insights core. */
export type InsightFailure = InsightNotFound | InvalidInsightTransition;
