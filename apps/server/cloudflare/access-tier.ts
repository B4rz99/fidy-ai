import { UserId } from "@fidy/server/identity-reference";
import { Option, Schema } from "effect";
import { activeTrialPeriodCondition } from "@fidy/server/identity-operations";

/**
 * Decide Pro standing inside the caller's D1 unit from the original TrialPeriod or a settled
 * paid period at the same instant as its protected action. No independent tier fact is stored.
 */
export const activeProUserCondition = (
  input: Readonly<{ userId: string; nowEpochMs: number }>
): Readonly<{ sql: string; params: ReadonlyArray<string | number | Uint8Array> }> => {
  const subject = Schema.decodeOption(UserId)(input.userId);
  if (Option.isNone(subject)) return { sql: "0", params: [] };
  const trial = activeTrialPeriodCondition({ ...input, userId: subject.value });
  return {
    sql: `(${trial.sql} OR EXISTS (SELECT 1 FROM subscriptions AS subscription
      WHERE subscription.user_id = ? AND subscription.paid_period_ends_at_ms > ?
      AND EXISTS (SELECT 1 FROM billing_paid_periods AS period
        WHERE period.attempt_id = subscription.attempt_id AND period.starts_at_ms <= ?)))`,
    params: [...trial.params, input.userId, input.nowEpochMs, input.nowEpochMs],
  };
};
