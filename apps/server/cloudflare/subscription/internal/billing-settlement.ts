import { type BillingAttemptId } from "../../../src/core/subscription/contract";
import { type WompiBillingStatus, type WompiTransactionId } from "./wompi-model";
import { wompiRetryOpportunity } from "./billing-rules";
import { Duration, Option } from "effect";

type PaidPeriod = Readonly<{
  startsAtMs: number;
  endsAtMs: number;
  renewalAnchorMs: number;
}>;
export type VerifiedOutcome =
  | Readonly<{ status: "APPROVED"; finalizedAtMs: number; paidPeriod: PaidPeriod }>
  | Readonly<{
      status: Exclude<WompiBillingStatus, "APPROVED">;
      finalizedAtMs: Option.Option<number>;
    }>;
type Settlement = Readonly<{
  db: D1Database;
  attemptId: BillingAttemptId;
  transactionId: WompiTransactionId;
  observedAtMs: number;
  outcome: VerifiedOutcome;
}>;
const retryOpportunityMs = Duration.toMillis(wompiRetryOpportunity);

const evidenceAndOutcome = (input: Settlement): ReadonlyArray<D1PreparedStatement> => {
  const { db, attemptId, transactionId, observedAtMs, outcome } = input;
  const negative =
    outcome.status === "DECLINED" || outcome.status === "VOIDED" || outcome.status === "ERROR";
  return [
    db
      .prepare(`INSERT INTO billing_provider_transactions
      (transaction_id, attempt_id, status, first_observed_at_ms, negative_observed_at_ms, finalized_at_ms)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(transaction_id) DO UPDATE SET
        first_observed_at_ms=COALESCE(first_observed_at_ms,excluded.first_observed_at_ms),
        status = CASE WHEN status = 'APPROVED' THEN status ELSE excluded.status END,
        negative_observed_at_ms = CASE
          WHEN status = 'APPROVED' THEN negative_observed_at_ms
          WHEN excluded.status = 'PENDING' THEN NULL
          WHEN status = 'PENDING' THEN excluded.negative_observed_at_ms
          ELSE COALESCE(negative_observed_at_ms, excluded.negative_observed_at_ms) END,
        finalized_at_ms = CASE WHEN status = 'APPROVED' THEN finalized_at_ms
          ELSE excluded.finalized_at_ms END
      WHERE attempt_id = excluded.attempt_id`)
      .bind(
        transactionId,
        attemptId,
        outcome.status,
        observedAtMs,
        negative ? observedAtMs : null,
        outcome.status === "APPROVED"
          ? outcome.finalizedAtMs
          : Option.getOrNull(outcome.finalizedAtMs)
      ),
    db
      .prepare(`UPDATE billing_attempts SET status = 'succeeded', finalized_at_ms =
      (SELECT MIN(finalized_at_ms) FROM billing_provider_transactions
        WHERE attempt_id = ? AND status = 'APPROVED')
      WHERE id = ? AND status <> 'succeeded' AND EXISTS
      (SELECT 1 FROM billing_provider_transactions WHERE attempt_id = ? AND status = 'APPROVED')`)
      .bind(attemptId, attemptId, attemptId),
    db
      .prepare(`UPDATE billing_attempts SET status = 'failed', finalized_at_ms = ?
      WHERE id = ? AND status = 'pending' AND EXISTS
        (SELECT 1 FROM billing_provider_transactions WHERE attempt_id = ? AND status IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM billing_provider_transactions WHERE attempt_id = ?
        AND status IN ('PENDING','APPROVED'))
      AND (SELECT MIN(negative_observed_at_ms) FROM billing_provider_transactions WHERE attempt_id = ?) <= ?`)
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
  const { db, attemptId, observedAtMs, outcome } = input;
  const period =
    outcome.status === "APPROVED" ? Option.some(outcome.paidPeriod) : Option.none<PaidPeriod>();
  return [
    db
      .prepare(`UPDATE billing_attempts SET paid_starts_at_ms=?,paid_ends_at_ms=?,paid_renewal_anchor_ms=?
      WHERE id=? AND status='succeeded' AND paid_starts_at_ms IS NULL AND ? IS NOT NULL`)
      .bind(
        Option.getOrNull(Option.map(period, (paid) => paid.startsAtMs)),
        Option.getOrNull(Option.map(period, (paid) => paid.endsAtMs)),
        Option.getOrNull(Option.map(period, (paid) => paid.renewalAnchorMs)),
        attemptId,
        Option.getOrNull(Option.map(period, (paid) => paid.startsAtMs))
      ),
    db
      .prepare(`INSERT INTO subscriptions(user_id,attempt_id,price_id,paid_period_ends_at_ms,renewal_anchor_ms)
      SELECT user_id,id,price_id,paid_ends_at_ms,paid_renewal_anchor_ms FROM billing_attempts
      WHERE id=? AND status='succeeded' AND paid_starts_at_ms IS NOT NULL
      ON CONFLICT(user_id) DO UPDATE SET attempt_id=excluded.attempt_id,price_id=excluded.price_id,
        paid_period_ends_at_ms=excluded.paid_period_ends_at_ms,renewal_anchor_ms=excluded.renewal_anchor_ms
      WHERE excluded.paid_period_ends_at_ms>subscriptions.paid_period_ends_at_ms`)
      .bind(attemptId),
    db
      .prepare(`INSERT OR IGNORE INTO audit_entries(record_type,attempt_id,transition,occurred_at_ms)
      SELECT 'billing_transition',id,status,? FROM billing_attempts WHERE id=? AND status IN('succeeded','failed')`)
      .bind(observedAtMs, attemptId),
    db
      .prepare(`UPDATE billing_attempts SET recovery_case_id=no_charge_case_id,recovery_reviewed_at_ms=?
      WHERE id=? AND status='succeeded' AND no_charge_confirmed_at_ms IS NOT NULL AND recovery_case_id IS NULL`)
      .bind(observedAtMs, attemptId),
    db
      .prepare(`UPDATE billing_attempts SET followup_kind=NULL,followup_due_at_ms=NULL
      WHERE user_id=(SELECT user_id FROM billing_attempts WHERE id=?) AND followup_kind IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM subscriptions s WHERE s.attempt_id=billing_attempts.id)`)
      .bind(attemptId),
    db
      .prepare(`UPDATE billing_attempts SET followup_kind='renewal_due',followup_due_at_ms=paid_ends_at_ms
      WHERE id=? AND paid_starts_at_ms IS NOT NULL AND followup_kind IS NULL
      AND EXISTS(SELECT 1 FROM subscriptions s WHERE s.attempt_id=billing_attempts.id)`)
      .bind(attemptId),
  ];
};

/** Persist verified evidence and all resulting Subscription state as one guarded D1 atomic unit. */
export const recordVerifiedBillingEvidence = (input: Settlement): Promise<void> =>
  input.db.batch([...evidenceAndOutcome(input), ...standingAndIntent(input)]).then(() => undefined);
