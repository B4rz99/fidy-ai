import { Schema } from "effect";
import { UserId } from "@fidy/server/identity-runtime";
import { BillingEmail, CardEnrollmentId, PaymentRequestId } from "@fidy/server/client";

const Claim = Schema.Struct({
  userId: UserId,
  enrollmentId: CardEnrollmentId,
  paymentRequestId: PaymentRequestId,
  billingEmail: BillingEmail,
});

/**
 * Atomically claims one User-owned prepared CardEnrollment for one browser payment action.
 * The caller must already have verified exact Origin, a fresh WebSession, current Consent,
 * the submitted decisions, and a bounded decoded request. Only a successful claim may
 * start provider source creation. Failure is deliberately indistinguishable from replay,
 * expiry, an unrelated User, or another concurrent claimant; none authorizes a retry of
 * an ambiguous provider request.
 */
// @effect-diagnostics-next-line asyncFunction:off missingPipeableSignature:off
export const claimPreparedCardEnrollment = async (
  db: D1Database,
  input: typeof Claim.Type,
  nowMs: number
): Promise<boolean> => {
  const claim = Schema.decodeSync(Claim)(input);
  const result = await db
    .prepare(`UPDATE card_enrollments SET status = 'creating',
      payment_request_id = ?, billing_email = ?, accepted_at_ms = ?
    WHERE id = ? AND user_id = ? AND status = 'prepared' AND expires_at_ms > ?
      AND payment_source_mode = 'create'`)
    .bind(
      claim.paymentRequestId,
      claim.billingEmail,
      nowMs,
      claim.enrollmentId,
      claim.userId,
      nowMs
    )
    .run();
  return result.meta.changes === 1;
};
