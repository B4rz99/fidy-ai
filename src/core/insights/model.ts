import { Array as Arr, BigDecimal, Schema, SchemaTransformation, Struct } from "effect";
import { IanaTimeZone, Locale, ServiceMarket } from "~/core/_shared/context";
import { Currency, Money, type ReadonlyMoney } from "~/core/_shared/money";
import { InsightKind } from "./reference";

/** Stable identity of one generated occurrence. */
export const InsightEventId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("InsightEventId")
);
export type InsightEventId = typeof InsightEventId.Type;

/** Stable identity of the schedule whose revision generated an occurrence. */
export const ScheduleId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("ScheduleId"));
export type ScheduleId = typeof ScheduleId.Type;

/** Revisions start at one and increase whenever a Schedule's instructions change. */
export const ScheduleVersion = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)).pipe(
  Schema.brand("ScheduleVersion")
);
export type ScheduleVersion = typeof ScheduleVersion.Type;

/** The forward-only attention lifecycle shared by every InsightEvent consumer. */
export const InsightLifecycleState = Schema.Literals(["pending", "delivered", "read", "dismissed"]);
export type InsightLifecycleState = typeof InsightLifecycleState.Type;

const groupCurrenciesMatch = Schema.makeFilter<
  Readonly<{
    currency: Currency;
    inflow: ReadonlyMoney;
    outflow: ReadonlyMoney;
  }>
>((group) => {
  if (group.inflow.currency !== group.currency) {
    return { path: ["inflow", "currency"], issue: "Expected the group Currency" };
  }
  if (group.outflow.currency !== group.currency) {
    return { path: ["outflow", "currency"], issue: "Expected the group Currency" };
  }
  if (BigDecimal.isZero(group.inflow.amount) && BigDecimal.isZero(group.outflow.amount)) {
    return "Expected at least one non-zero Money value";
  }
  return undefined;
});

/** Exact inflow and outflow Money retained separately for one Currency. */
export const InsightMoneyGroup = Schema.Struct({
  currency: Currency,
  inflow: Money,
  outflow: Money,
})
  .check(groupCurrenciesMatch)
  .annotate({ identifier: "InsightMoneyGroup" });
export type InsightMoneyGroup = typeof InsightMoneyGroup.Type;

const deterministicCurrencyOrder = Schema.makeFilter<
  ReadonlyArray<Readonly<{ currency: Currency }>>
>((groups) => {
  for (const [index, [previous, current]] of Arr.zip(groups, groups.slice(1)).entries()) {
    if (previous.currency >= current.currency) {
      return {
        path: [index + 1, "currency"],
        issue: "Expected unique Currency groups in alphabetic order",
      };
    }
  }
  return undefined;
});

/** Currency groups in unique alphabetic order; an empty array means no Money was retained. */
export const InsightMoneyGroups = Schema.Array(InsightMoneyGroup).check(deterministicCurrencyOrder);

const UtcTimestamp = Schema.String.annotate({ format: "date-time" }).pipe(
  Schema.decodeTo(Schema.DateTimeUtc, SchemaTransformation.dateTimeUtcFromString)
);

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
  moneyGroups: InsightMoneyGroups,
  lifecycleState: InsightLifecycleState,
}).annotate({ identifier: "InsightEvent" });
export type InsightEvent = typeof InsightEvent.Type;

/** Trusted generation facts; the operation supplies identity and starts lifecycle at pending. */
export const InsightGenerationInput = InsightEvent.mapFields(
  Struct.omit(["id", "lifecycleState"])
).annotate({ identifier: "InsightGenerationInput" });
export type InsightGenerationInput = typeof InsightGenerationInput.Type;

/** Stable identity of one append-only provider send record. */
export const DeliveryAttemptId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand("DeliveryAttemptId")
);
export type DeliveryAttemptId = typeof DeliveryAttemptId.Type;

/** Evidence supplied after an external consumer actually attempted a send. */
export const InsightDeliveryAttempt = Schema.Struct({
  id: DeliveryAttemptId,
  insightEventId: InsightEventId,
  sentAt: UtcTimestamp,
  channel: Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(32)),
  provider: Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(64)),
  providerMessageId: Schema.NonEmptyString.check(Schema.isTrimmed(), Schema.isMaxLength(256)),
}).annotate({ identifier: "InsightDeliveryAttempt" });
export type InsightDeliveryAttempt = typeof InsightDeliveryAttempt.Type;

/** Provider evidence supplied by a consumer; ids are assigned from operation context. */
export const DeliveryEvidenceInput = InsightDeliveryAttempt.mapFields(
  Struct.omit(["id", "insightEventId"])
).annotate({ identifier: "DeliveryEvidenceInput" });
export type DeliveryEvidenceInput = typeof DeliveryEvidenceInput.Type;
