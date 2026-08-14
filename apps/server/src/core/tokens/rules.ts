import { DateTime, Effect } from "effect";
import { PatIdleDuration } from "./model";

/** Computes a PAT's renewable idle deadline 90 days after creation or authenticated use. */
export const computePatIdleExpiry = (
  usedAt: DateTime.Utc
): Effect.Effect<DateTime.Utc, never, never> =>
  Effect.succeed(DateTime.addDuration(usedAt, PatIdleDuration));
