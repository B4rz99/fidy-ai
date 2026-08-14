import { Effect } from "effect";
import { InvalidInsightTransition } from "./errors";
import { type InsightLifecycleState } from "./model";

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
