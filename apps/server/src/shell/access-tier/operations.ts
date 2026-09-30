import type { OwnedStatement } from "~/shell/_shared/owned-statement";
import { activeTrialPredicate } from "~/shell/identity/operations";
import { activePaidSubscriptionPredicate } from "~/shell/subscription/operations";

/**
 * Derive Pro activity for one resolved User at a single UTC decision instant inside the caller's
 * D1 statement. An active original TrialPeriod or settled Subscription suffices. Embed this
 * predicate and its bindings together, retaining the caller's authorization guard and atomic
 * unit; a separate read before a mutation would not preserve the decision's atomicity.
 * No independent AccessTier fact is stored and this predicate grants no caller authority.
 */
export const activeProUserPredicate = (
  input: Readonly<{ userId: string; nowEpochMs: number }>
): OwnedStatement => {
  const trial = activeTrialPredicate(input);
  const subscription = activePaidSubscriptionPredicate(input);
  return {
    sql: `(${trial.sql} OR ${subscription.sql})`,
    params: [...trial.params, ...subscription.params],
  };
};
