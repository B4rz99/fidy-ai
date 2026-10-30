import { UserId } from "~/core/identity/contract";
import type { OwnedStatement } from "~/shell/owner-write/contract";
import { Option, Schema } from "effect";
import { activePaidSubscriptionForUserSelection } from "~/shell/subscription/operations";
import { activeTrialPeriodForUserSelection } from "~/shell/identity/operations";

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
  return activeProForUserSelection({
    users: { sql: "SELECT ?", params: [subject.value] },
    nowEpochMs: input.nowEpochMs,
  });
};

/** Observe Pro standing for the same bounded User selection as the protected read. */
export const activeProForUserSelection = (
  input: Readonly<{ users: OwnedStatement; nowEpochMs: number }>
): OwnedStatement => {
  const trial = activeTrialPeriodForUserSelection(input);
  const paid = activePaidSubscriptionForUserSelection(input);
  return {
    sql: `(${trial.sql} OR ${paid.sql})`,
    params: [...trial.params, ...paid.params],
  };
};
