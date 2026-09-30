import type { UserId } from "../../src/core/identity/contract";

const trialDurationMs = 604_800_000;

/**
 * Initialize the immutable 168-hour TrialPeriod at verified onboarding completion.
 * The caller commits this with stable User creation and proof consumption in one D1 batch.
 * An existing User's TrialPeriod is never replaced, renewed, or extended.
 */
export const prepareInitialTrialPeriod = ({
  db,
  userId,
  verifiedAtMs,
}: {
  readonly db: D1Database;
  readonly userId: UserId;
  readonly verifiedAtMs: number;
}): D1PreparedStatement =>
  db
    .prepare(`INSERT INTO trial_periods (user_id, started_at_ms, ends_at_ms)
    VALUES (?, ?, ?)`)
    .bind(userId, verifiedAtMs, verifiedAtMs + trialDurationMs);
