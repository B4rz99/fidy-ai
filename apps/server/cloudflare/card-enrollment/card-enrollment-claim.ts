import { Schema } from "effect";
import { UserId } from "@fidy/server/identity-runtime";
import { BillingEmail, CardEnrollmentId, PaymentRequestId } from "@fidy/server/client";

const Claim = Schema.Struct({
  userId: UserId,
  enrollmentId: CardEnrollmentId,
  paymentRequestId: PaymentRequestId,
  billingEmail: BillingEmail,
  paymentSourceMode: Schema.Literals(["create", "reuse"]),
});

/**
 * Atomically claims one User-owned prepared CardEnrollment for one browser payment action.
 * The caller must already have verified exact Origin, a fresh WebSession, current Consent,
 * the submitted decisions, and a bounded decoded request. Only a successful claim may
 * start provider source creation. Failure is deliberately indistinguishable from replay,
 * expiry, an unrelated User, or another concurrent claimant; none authorizes a retry of
 * an ambiguous provider request.
 */
export const claimPreparedCardEnrollment = ({
  db,
  input,
  nowMs,
}: Readonly<{ db: D1Database; input: typeof Claim.Type; nowMs: number }>): Promise<boolean> => {
  const claim = Schema.decodeSync(Claim)(input);
  return db
    .prepare(`UPDATE card_enrollments SET status = 'creating',
      payment_request_id = ?, accepted_at_ms = ?
    WHERE id = ? AND user_id = ? AND status = 'prepared' AND expires_at_ms > ?
      AND payment_source_mode = ? AND billing_email = ?`)
    .bind(
      claim.paymentRequestId,
      nowMs,
      claim.enrollmentId,
      claim.userId,
      nowMs,
      claim.paymentSourceMode,
      claim.billingEmail
    )
    .run()
    .then((result) => result.meta.changes === 1);
};
