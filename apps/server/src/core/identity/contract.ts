import { Duration, Schema } from "effect";
import { UtcTimestamp } from "~/core/_shared/time";

const trialHours = 168;
const sevenDaysInMilliseconds = Duration.toMillis(Duration.hours(trialHours));
const TrialPeriodFields = Schema.Struct({
  startedAt: UtcTimestamp,
  endsAt: UtcTimestamp,
});
const exactTrialDuration = Schema.makeFilter<typeof TrialPeriodFields.Type>((period) =>
  period.endsAt.epochMilliseconds - period.startedAt.epochMilliseconds === sevenDaysInMilliseconds
    ? undefined
    : { path: ["endsAt"], issue: "Expected exactly 168 hours after startedAt" }
);

/**
 * TrialPeriod is the immutable, half-open [startedAt, endsAt) interval for a User's single
 * no-card Pro trial. endsAt must be exactly 168 hours after startedAt.
 */
export const TrialPeriod = TrialPeriodFields.check(exactTrialDuration).annotate({
  identifier: "TrialPeriod",
});
export type TrialPeriod = typeof TrialPeriod.Type;
