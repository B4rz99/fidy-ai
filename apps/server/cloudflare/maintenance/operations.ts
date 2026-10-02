import { Cause, Effect, Exit } from "effect";
import { type ScheduledActivity, ScheduledWorkFailed } from "./contract";

/**
 * Attempt independent activities in order and report a closed failure only after the last one.
 * Interruption stops the schedule and preserves owner cleanup rather than becoming a work failure.
 * Each owner still decides eligibility and retention; successful scheduling grants no authority.
 */
export const executeSchedule = <E>(
  activities: ReadonlyArray<ScheduledActivity<E>>
): Effect.Effect<void, ScheduledWorkFailed> =>
  Effect.gen(function* () {
    let failed = false;
    for (const { operation, work } of activities) {
      const result = yield* Effect.exit(work.pipe(Effect.withSpan(operation)));
      if (Exit.isFailure(result)) {
        if (Cause.hasInterrupts(result.cause)) return yield* Effect.interrupt;
        failed = true;
        yield* Effect.logWarning({ component: "scheduled-work", operation, outcome: "failed" });
      }
    }
    if (failed) return yield* new ScheduledWorkFailed();
  });
