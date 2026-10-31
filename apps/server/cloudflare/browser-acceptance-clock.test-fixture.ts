import { setSystemTime } from "bun:test";
import { Clock, Effect, Option, Schema } from "effect";

const maximumAdvanceMilliseconds = 5_000;
export const AcceptanceClockAdvance = Schema.Struct({
  milliseconds: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(maximumAdvanceMilliseconds)
  ),
});
const origin = Effect.runSync(Clock.currentTimeMillis);
let monotonicOrigin = performance.now();
let advancedMilliseconds = 0;
let pausedAt = Option.none<number>();

/** The acceptance process owns this clock. Native storage and production admission stay active. */
export const synchronizeAcceptanceClock = (): void => {
  const elapsed = Option.getOrElse(pausedAt, () => performance.now()) - monotonicOrigin;
  setSystemTime(Math.floor(origin + elapsed + advancedMilliseconds));
};

export const pauseAcceptanceClock = (): void => {
  if (Option.isNone(pausedAt)) pausedAt = Option.some(performance.now());
  synchronizeAcceptanceClock();
};

export const resumeAcceptanceClock = (): void => {
  if (Option.isSome(pausedAt)) monotonicOrigin += performance.now() - pausedAt.value;
  pausedAt = Option.none();
  synchronizeAcceptanceClock();
};

/** Advance only after an observed, declared refusal; never alter grants or retained authority. */
export const advanceAcceptanceClock = (milliseconds: number): void => {
  advancedMilliseconds += milliseconds;
  synchronizeAcceptanceClock();
};
