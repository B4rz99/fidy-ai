import { activeProGrantSelection } from "~/shell/pro-grants/operations";
import { UserId } from "~/core/identity/contract";
import type { OwnedStatement } from "~/shell/owner-write/contract";
import { Option, Schema } from "effect";
import { activePaidSubscriptionForUserSelection } from "~/shell/subscription/operations";
import { activeTrialPeriodForUserSelection } from "~/shell/identity/operations";

/**
 * Decide Pro standing inside the caller's D1 unit from the original TrialPeriod or a settled
 * paid period or ManualProGrant at the same instant as its protected action. The explicit stable User is not
 * authorization: callers must compose their live credential/Consent guard in that same unit.
 * Invalid identities and missing or inactive periods are false; storage failure remains the
 * caller's closed unavailable outcome. Manual grants never establish credential or Consent authority.
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
  const grant = activeProGrantSelection(input.users);
  return {
    sql: `(${trial.sql} OR ${paid.sql} OR ${grant.sql})`,
    params: [...trial.params, ...paid.params, ...grant.params],
  };
};
