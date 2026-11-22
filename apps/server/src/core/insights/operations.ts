import { Cron, Data, DateTime, Effect } from "effect";
import type { IanaTimeZone } from "~/core/_shared/context";
import type {
  ConfirmationDay,
  InsightDeliveryDecision,
  ReminderCadence,
  ReminderTiming,
  WeeklyPeriods,
  WeeklyTiming,
} from "./contract";
import { type InsightLifecycleState, InvalidInsightTransition } from "./contract";

const elapsedDayMs = 86_400_000;

export const captureConfirmationDay = (
  input: Readonly<{
    confirmedAt: DateTime.Utc;
    timeZone: IanaTimeZone;
  }>
): ConfirmationDay => {
  const start = DateTime.startOf(
    DateTime.setZoneNamedUnsafe(input.confirmedAt, input.timeZone),
    "day"
  );

  return {
    localDate: DateTime.formatIsoDate(start),
    timeZone: input.timeZone,
    from: DateTime.toUtc(start),
    toExclusive: DateTime.toUtc(DateTime.add(start, { days: 1 })),
  };
};

type RecurringDigestTiming = Readonly<{
  scheduledAt: DateTime.Utc;
  expiresAt: DateTime.Utc;
}>;

export const recurringDigestTiming = (day: ConfirmationDay): RecurringDigestTiming => {
  const scheduledAt = DateTime.toUtc(
    DateTime.setParts(DateTime.setZoneNamedUnsafe(day.toExclusive, day.timeZone), {
      hour: 9,
      minute: 0,
      second: 0,
      millisecond: 0,
    })
  );

  return {
    scheduledAt,
    expiresAt: DateTime.makeUnsafe(scheduledAt.epochMilliseconds + elapsedDayMs),
  };
};

const threeDayInterval = 3;

const maximumCalendarCandidates = 7;

type ReminderInstructions = Readonly<{
  cadence: ReminderCadence;
  timing: ReminderTiming;
  timeZone: IanaTimeZone;
}>;

const reminderCron = (input: ReminderInstructions): Cron.Cron => {
  let weekdays = "*";

  if (input.cadence.kind === "weekdays") weekdays = "1-5";

  if (input.cadence.kind === "weekly") weekdays = String(input.cadence.weekday);

  return Cron.parseUnsafe(
    `${input.timing.minute} ${input.timing.hour} * * ${weekdays}`,
    input.timeZone
  );
};

const selectReminderDate = (
  input: ReminderInstructions,
  candidate: DateTime.Utc,
  advance: (instant: DateTime.Utc) => DateTime.Utc
): DateTime.Utc => {
  if (input.cadence.kind !== "every-three-days") return candidate;
  const anchor = DateTime.makeUnsafe(input.cadence.anchorDate);
  let next = candidate;

  for (let attempt = 0; attempt < maximumCalendarCandidates; attempt += 1) {
    const localDate = DateTime.makeUnsafe(
      DateTime.formatIsoDate(DateTime.setZoneNamedUnsafe(next, input.timeZone))
    );

    const days = Math.round(
      (localDate.epochMilliseconds - anchor.epochMilliseconds) / elapsedDayMs
    );

    if (days % threeDayInterval === 0) return next;
    next = advance(next);
  }

  throw new Error("Reminder calendar could not locate an anchored occurrence");
};

export const nextReminderOccurrence = (
  input: ReminderInstructions & Readonly<{ after: DateTime.Utc }>
): DateTime.Utc => {
  const cron = reminderCron(input);

  const advance = (instant: DateTime.Utc): DateTime.Utc =>
    DateTime.makeUnsafe(Cron.next(cron, instant));

  return selectReminderDate(input, advance(input.after), advance);
};

export const latestReminderOccurrence = (
  input: ReminderInstructions & Readonly<{ atOrBefore: DateTime.Utc }>
): DateTime.Utc => {
  const cron = reminderCron(input);
  const minute = DateTime.startOf(input.atOrBefore, "minute");

  const retreat = (instant: DateTime.Utc): DateTime.Utc =>
    DateTime.makeUnsafe(Cron.prev(cron, instant));

  return selectReminderDate(
    input,
    Cron.match(cron, minute) ? minute : retreat(input.atOrBefore),
    retreat
  );
};

const deliveryOpeningHour = 9;

const deliveryClosingHour = 19;

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

export const insightDeliveryDeadline = (
  input: Readonly<{
    scheduledAt: DateTime.Utc;
    nextScheduledAt: DateTime.Utc;
  }>
): DateTime.Utc =>
  DateTime.makeUnsafe(
    Math.min(
      input.scheduledAt.epochMilliseconds + elapsedDayMs,
      input.nextScheduledAt.epochMilliseconds
    )
  );

export const budgetAlertDeadline = (
  input: Readonly<{ detectedAt: DateTime.Utc; monthEnd: DateTime.Utc }>
): DateTime.Utc =>
  DateTime.makeUnsafe(
    Math.min(input.detectedAt.epochMilliseconds + elapsedDayMs, input.monthEnd.epochMilliseconds)
  );

const Delivery = Data.taggedEnum<InsightDeliveryDecision>();

export const decideInsightDelivery = (
  input: Readonly<{
    scheduledAt: DateTime.Utc;
    expiresAt: DateTime.Utc;
    timeZone: IanaTimeZone;
    now: DateTime.Utc;
  }>
): InsightDeliveryDecision => {
  if (input.now.epochMilliseconds >= input.expiresAt.epochMilliseconds) return Delivery.Expired();

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

  if (eligible.epochMilliseconds >= input.expiresAt.epochMilliseconds) return Delivery.Expired();

  return eligible.epochMilliseconds > input.now.epochMilliseconds
    ? Delivery.Deferred({ nextEligibleAt: DateTime.toUtc(eligible) })
    : Delivery.Ready();
};

const allowedTargets: Readonly<
  Record<InsightLifecycleState, ReadonlyArray<InsightLifecycleState>>
> = {
  pending: ["delivered", "read", "dismissed"],
  delivered: ["read", "dismissed"],
  read: ["dismissed"],
  dismissed: [],
};

export const allowedInsightTransitions = (
  current: InsightLifecycleState
): ReadonlyArray<InsightLifecycleState> => allowedTargets[current];

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
