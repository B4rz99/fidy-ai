import { Effect } from "effect";
import { InsightLifecycleState, InvalidInsightTransition } from "./contract";

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

/**
 * Complete source states that may advance to a target. Durable conditional writes
 * must check these again at commit, not rely on an earlier lifecycle read.
 */
export const insightTransitionSources = (
  target: InsightLifecycleState
): ReadonlyArray<InsightLifecycleState> =>
  InsightLifecycleState.literals.filter((current) =>
    allowedInsightTransitions(current).includes(target)
  );

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
