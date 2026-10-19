import { setSystemTime } from "bun:test";
import { Clock, Effect, Schema } from "effect";

const maximumAdvanceMilliseconds = 5_000;
export const AcceptanceClockAdvance = Schema.Struct({
  milliseconds: Schema.Int.check(
    Schema.isGreaterThan(0),
    Schema.isLessThanOrEqualTo(maximumAdvanceMilliseconds)
  ),
});
const origin = Effect.runSync(Clock.currentTimeMillis);
const monotonicOrigin = performance.now();
let advancedMilliseconds = 0;

/** The acceptance process owns this clock. Native storage and production admission stay active. */
export const synchronizeAcceptanceClock = (): void => {
  setSystemTime(Math.floor(origin + performance.now() - monotonicOrigin + advancedMilliseconds));
};

/** Advance only after an observed, declared refusal; never alter grants or retained authority. */
export const advanceAcceptanceClock = (milliseconds: number): void => {
  advancedMilliseconds += milliseconds;
  synchronizeAcceptanceClock();
};
