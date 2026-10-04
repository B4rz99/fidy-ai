import { Cron, DateTime, Effect } from "effect";
import type { IanaTimeZone } from "../_shared/context";
import type { InsightDeliveryDecision, WeeklyPeriods, WeeklyTiming } from "./contract";
import { type InsightLifecycleState, InvalidInsightTransition } from "./contract";

const weeklyDeliveryFreshnessMs = 86_400_000;
const deliveryOpeningHour = 9;
const deliveryClosingHour = 19;

/** Calculate report bounds from captured schedule context, never the actual delivery time. */
export const weeklyPeriods = (
  input: Readonly<{
    scheduledAt: DateTime.Utc;
    timeZone: IanaTimeZone;
  }>
): WeeklyPeriods => {
  const cutoff = DateTime.setZoneNamedUnsafe(input.scheduledAt, input.timeZone);
  const previousCutoff = DateTime.subtract(cutoff, { days: 7 });
  return {
    current: { from: DateTime.toUtc(previousCutoff), toExclusive: input.scheduledAt },
    previous: {
      from: DateTime.toUtc(DateTime.subtract(previousCutoff, { days: 7 })),
      toExclusive: DateTime.toUtc(previousCutoff),
    },
  };
};

/** Find the next wall-clock occurrence strictly after an instant using validated weekly timing. */
export const nextWeeklyOccurrence = (
  input: Readonly<{
    after: DateTime.Utc;
    timing: WeeklyTiming;
    timeZone: IanaTimeZone;
  }>
): DateTime.Utc =>
  DateTime.makeUnsafe(
    Cron.next(
      Cron.parseUnsafe(
        `${input.timing.minute} ${input.timing.hour} * * ${input.timing.weekday}`,
        input.timeZone
      ),
      input.after
    )
  );

/** Select the latest cutoff at or before now; callers still enforce schedule activation and freshness. */
export const latestWeeklyOccurrence = (
  input: Readonly<{
    atOrBefore: DateTime.Utc;
    timing: WeeklyTiming;
    timeZone: IanaTimeZone;
  }>
): DateTime.Utc => {
  const cron = Cron.parseUnsafe(
    `${input.timing.minute} ${input.timing.hour} * * ${input.timing.weekday}`,
    input.timeZone
  );
  const minute = DateTime.startOf(input.atOrBefore, "minute");
  return Cron.match(cron, minute) ? minute : DateTime.makeUnsafe(Cron.prev(cron, input.atOrBefore));
};

/** Snapshot the last admissible send instant; a delivery started earlier must still reconcile. */
export const insightDeliveryDeadline = (
  input: Readonly<{
    scheduledAt: DateTime.Utc;
    nextScheduledAt: DateTime.Utc;
  }>
): DateTime.Utc =>
  DateTime.makeUnsafe(
    Math.min(
      input.scheduledAt.epochMilliseconds + weeklyDeliveryFreshnessMs,
      input.nextScheduledAt.epochMilliseconds
    )
  );

/** Decide freshness and the captured-zone [09:00,19:00) window without authorizing a send. */
export const decideInsightDelivery = (
  input: Readonly<{
    scheduledAt: DateTime.Utc;
    expiresAt: DateTime.Utc;
    timeZone: IanaTimeZone;
    now: DateTime.Utc;
  }>
): InsightDeliveryDecision => {
  if (input.now.epochMilliseconds >= input.expiresAt.epochMilliseconds) return { _tag: "Expired" };
  const earliest = DateTime.makeUnsafe(
    Math.max(input.now.epochMilliseconds, input.scheduledAt.epochMilliseconds)
  );
  const local = DateTime.setZoneNamedUnsafe(earliest, input.timeZone);
  const hour = DateTime.getPart(local, "hour");
  let eligible = local;
  if (hour < deliveryOpeningHour) {
    eligible = DateTime.setParts(local, {
      hour: deliveryOpeningHour,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
  } else if (hour >= deliveryClosingHour) {
    eligible = DateTime.setParts(DateTime.add(local, { days: 1 }), {
      hour: deliveryOpeningHour,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
  }
  if (eligible.epochMilliseconds >= input.expiresAt.epochMilliseconds) return { _tag: "Expired" };
  return eligible.epochMilliseconds > input.now.epochMilliseconds
    ? { _tag: "Deferred", nextEligibleAt: DateTime.toUtc(eligible) }
    : { _tag: "Ready" };
};

const allowedTargets: Readonly<
  Record<InsightLifecycleState, ReadonlyArray<InsightLifecycleState>>
> = {
  pending: ["delivered", "read", "dismissed"],
  delivered: ["read", "dismissed"],
  read: ["dismissed"],
  dismissed: [],
};

/** Returns the complete valid next states for one current lifecycle state. */
export const allowedInsightTransitions = (
  current: InsightLifecycleState
): ReadonlyArray<InsightLifecycleState> => allowedTargets[current];

/** Validates one monotonic lifecycle movement, including direct forward skips. */
export const transitionInsight = (
  input: Readonly<{
    current: InsightLifecycleState;
    target: InsightLifecycleState;
  }>
): Effect.Effect<InsightLifecycleState, InvalidInsightTransition> => {
  const { current, target } = input;
  return allowedInsightTransitions(current).includes(target)
    ? Effect.succeed(target)
    : Effect.fail(
        new InvalidInsightTransition({
          current,
          target,
          allowedTargets: allowedInsightTransitions(current),
        })
      );
};
