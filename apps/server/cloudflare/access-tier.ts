/**
 * Bounded AccessTier standing for adapters that must decide it inside one D1 unit: a User is Pro
 * while an active TrialPeriod or a Subscription's paid period covers the decision instant.
 *
 * The canonical decision is `~/core/access-tier/operations.ts:decideAccessTier`; this predicate is the bounded SQL projection
 * the statement publication unit embeds so that its Free-backfill reservation and its Pro exemption
 * are decided at the same instant and against the same evidence as the canonical rule. It derives
 * standing from the same tables that rule reads and persists no independent tier fact.
 */
export const activeProUserSql = `(EXISTS (SELECT 1 FROM trial_periods AS trial
    WHERE trial.user_id = ? AND trial.started_at_ms <= ? AND trial.ends_at_ms > ?)
  OR EXISTS (SELECT 1 FROM subscriptions AS subscription
    WHERE subscription.user_id = ? AND subscription.paid_period_ends_at_ms > ?
    AND EXISTS (SELECT 1 FROM billing_paid_periods AS period
      WHERE period.attempt_id = subscription.attempt_id AND period.starts_at_ms <= ?)))`;

/** Parameter values for one `activeProUserSql` use, in placeholder order. */
export const activeProUserParams = ({
  userId,
  nowEpochMs,
}: Readonly<{ userId: string; nowEpochMs: number }>): ReadonlyArray<string | number> => [
  userId,
  nowEpochMs,
  nowEpochMs,
  userId,
  nowEpochMs,
  nowEpochMs,
];
