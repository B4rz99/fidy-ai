import { UserId } from "~/core/identity/reference";
import type { OwnedStatement } from "~/shell/_shared/owned-statement";
import { Option, Schema } from "effect";
import { activePaidSubscriptionCondition } from "~/shell/subscription/operations";
import { activeTrialPeriodCondition } from "~/shell/identity/operations";

/**
 * Decide Pro standing inside the caller's D1 unit from the original TrialPeriod or a settled
 * paid period at the same instant as its protected action. The explicit stable User is not
 * authorization: callers must compose their live credential/Consent guard in that same unit.
 * Invalid identities and missing or inactive periods are false; storage failure remains the
 * caller's closed unavailable outcome. No independent tier fact or runtime authority is stored.
 */
export const activeProUserCondition = (
  input: Readonly<{ userId: string; nowEpochMs: number }>
): OwnedStatement => {
  const subject = Schema.decodeOption(UserId)(input.userId);
  if (Option.isNone(subject)) return { sql: "0", params: [] };
  const trial = activeTrialPeriodCondition({ ...input, userId: subject.value });
  const paid = activePaidSubscriptionCondition({ ...input, userId: subject.value });
  return {
    sql: `(${trial.sql} OR ${paid.sql})`,
    params: [...trial.params, ...paid.params],
  };
};
