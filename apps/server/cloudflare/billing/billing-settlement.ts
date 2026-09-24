import { type WompiBillingStatus, wompiRetryOpportunity } from "@fidy/server/subscription-runtime";
import { Duration, Option } from "effect";

type Settlement = Readonly<{
  db: D1Database;
  attemptId: string;
  transactionId: string;
  status: WompiBillingStatus;
  observedAtMs: number;
  finalizedAtMs: Option.Option<number>;
  periodStartMs: Option.Option<number>;
  periodEndMs: Option.Option<number>;
  renewalAnchorMs: Option.Option<number>;
}>;
const retryOpportunityMs = Duration.toMillis(wompiRetryOpportunity);

const evidenceAndOutcome = (input: Settlement): ReadonlyArray<D1PreparedStatement> => {
  const { db, attemptId, transactionId, status, observedAtMs, finalizedAtMs } = input;
  const negative = status === "DECLINED" || status === "VOIDED" || status === "ERROR";
  return [
    db
      .prepare(`INSERT OR IGNORE INTO billing_transaction_candidates (transaction_id, attempt_id)
      VALUES (?, ?)`)
      .bind(transactionId, attemptId),
    db
      .prepare(`INSERT INTO billing_transaction_evidence
      (transaction_id, attempt_id, status, first_observed_at_ms, negative_observed_at_ms, finalized_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(transaction_id) DO UPDATE SET
        status = CASE WHEN status = 'APPROVED' OR excluded.status = 'APPROVED' THEN 'APPROVED'
          WHEN status IN ('DECLINED','VOIDED','ERROR') THEN status ELSE excluded.status END,
        negative_observed_at_ms = COALESCE(negative_observed_at_ms, excluded.negative_observed_at_ms),
        finalized_at_ms = CASE WHEN excluded.status = 'APPROVED' AND status <> 'APPROVED'
          THEN excluded.finalized_at_ms ELSE COALESCE(finalized_at_ms, excluded.finalized_at_ms) END
      WHERE attempt_id = excluded.attempt_id`)
      .bind(
        transactionId,
        attemptId,
        status,
        observedAtMs,
        negative ? observedAtMs : null,
        Option.getOrNull(finalizedAtMs)
      ),
    db
      .prepare(`UPDATE billing_attempts SET status = 'succeeded', finalized_at_ms =
      (SELECT MIN(finalized_at_ms) FROM billing_transaction_evidence
        WHERE attempt_id = ? AND status = 'APPROVED')
      WHERE id = ? AND status <> 'succeeded' AND EXISTS
      (SELECT 1 FROM billing_transaction_evidence WHERE attempt_id = ? AND status = 'APPROVED')`)
      .bind(attemptId, attemptId, attemptId),
    db
      .prepare(`UPDATE billing_attempts SET status = 'failed', finalized_at_ms = ?
      WHERE id = ? AND status = 'pending' AND EXISTS
        (SELECT 1 FROM billing_transaction_evidence WHERE attempt_id = ?)
      AND NOT EXISTS (SELECT 1 FROM billing_transaction_evidence WHERE attempt_id = ?
        AND status IN ('PENDING','APPROVED'))
      AND (SELECT MIN(negative_observed_at_ms) FROM billing_transaction_evidence WHERE attempt_id = ?) <= ?`)
      .bind(
        observedAtMs,
        attemptId,
        attemptId,
        attemptId,
        attemptId,
        observedAtMs - retryOpportunityMs
      ),
  ];
};

const standingAndIntent = (input: Settlement): ReadonlyArray<D1PreparedStatement> => {
  const { db, attemptId, observedAtMs, periodStartMs, periodEndMs, renewalAnchorMs } = input;
  return [
    db
      .prepare(`INSERT OR IGNORE INTO billing_paid_periods
      (attempt_id, starts_at_ms, ends_at_ms, renewal_anchor_ms)
      SELECT ?, ?, ?, ? WHERE ? IS NOT NULL AND EXISTS
      (SELECT 1 FROM billing_attempts WHERE id = ? AND status = 'succeeded')`)
      .bind(
        attemptId,
        Option.getOrNull(periodStartMs),
        Option.getOrNull(periodEndMs),
        Option.getOrNull(renewalAnchorMs),
        Option.getOrNull(periodStartMs),
        attemptId
      ),
    // User is the stable coordination key: the guarded upsert serializes competing attempts in D1.
    db
      .prepare(`INSERT INTO subscriptions
      (user_id, attempt_id, price_id, paid_period_ends_at_ms, renewal_anchor_ms)
      SELECT a.user_id, a.id, a.price_id, p.ends_at_ms, p.renewal_anchor_ms
      FROM billing_attempts AS a JOIN billing_paid_periods AS p ON p.attempt_id = a.id
      WHERE a.id = ? AND a.status = 'succeeded'
      ON CONFLICT(user_id) DO UPDATE SET attempt_id = excluded.attempt_id,
        price_id = excluded.price_id, paid_period_ends_at_ms = excluded.paid_period_ends_at_ms,
        renewal_anchor_ms = excluded.renewal_anchor_ms
      WHERE excluded.paid_period_ends_at_ms > subscriptions.paid_period_ends_at_ms`)
      .bind(attemptId),
    db
      .prepare(`INSERT OR IGNORE INTO billing_audit (attempt_id, transition, occurred_at_ms)
      SELECT id, status, ? FROM billing_attempts WHERE id = ? AND status IN ('succeeded','failed')`)
      .bind(observedAtMs, attemptId),
    db
      .prepare(`DELETE FROM billing_followup_outbox
      WHERE attempt_id IN (SELECT id FROM billing_attempts WHERE user_id =
        (SELECT user_id FROM billing_attempts WHERE id = ?))
      AND NOT EXISTS (SELECT 1 FROM subscriptions WHERE subscriptions.attempt_id =
        billing_followup_outbox.attempt_id)`)
      .bind(attemptId),
    db
      .prepare(`INSERT OR IGNORE INTO billing_followup_outbox (attempt_id, kind, due_at_ms)
      SELECT p.attempt_id, 'renewal_due', p.ends_at_ms FROM billing_paid_periods AS p
      JOIN subscriptions AS s ON s.attempt_id = p.attempt_id WHERE p.attempt_id = ?`)
      .bind(attemptId),
  ];
};

/** Persist verified evidence and all resulting Subscription state as one guarded D1 atomic unit. */
export const recordVerifiedBillingEvidence = (input: Settlement): Promise<void> =>
  input.db.batch([...evidenceAndOutcome(input), ...standingAndIntent(input)]).then(() => undefined);
