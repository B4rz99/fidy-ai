import { Schema } from "effect";
import { type OwnedStatement } from "../../../src/shell/owner-write/contract";
import { UserId } from "../../../src/core/identity/contract";
import {
  BillingEmail,
  PaymentEnrollmentId,
  PaymentRequestId,
} from "../../../src/core/subscription/contract";

const Claim = Schema.Struct({
  userId: UserId,
  enrollmentId: PaymentEnrollmentId,
  paymentRequestId: PaymentRequestId,
  billingEmail: BillingEmail,
  paymentSourceMode: Schema.Literals(["create", "reuse"]),
  authorizationDigest: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))),
});

/**
 * Atomically claims one User-owned prepared PaymentEnrollment for one browser payment action.
 * The caller must already have verified exact Origin, a fresh WebSession, current Consent,
 * the submitted decisions, and a bounded decoded request. Only a successful claim may
 * start provider source creation. Failure is deliberately indistinguishable from replay,
 * expiry, an unrelated User, or another concurrent claimant; none authorizes a retry of
 * an ambiguous provider request.
 */
export const claimPreparedPaymentEnrollment = ({
  db,
  input,
  nowMs,
  guard,
}: Readonly<{
  db: D1Database;
  input: typeof Claim.Type;
  nowMs: number;
  guard: OwnedStatement;
}>): Promise<boolean> => {
  const claim = Schema.decodeSync(Claim)(input);
  return db
    .prepare(`UPDATE card_enrollments SET status = 'creating',
      payment_request_id = ?, accepted_at_ms = ?, authorization_digest = ?
    WHERE id = ? AND user_id = ? AND status = 'prepared' AND expires_at_ms > ?
      AND payment_source_mode = ? AND billing_email = ? AND EXISTS (${guard.sql})`)
    .bind(
      claim.paymentRequestId,
      nowMs,
      claim.authorizationDigest ?? null,
      claim.enrollmentId,
      claim.userId,
      nowMs,
      claim.paymentSourceMode,
      claim.billingEmail,
      ...guard.params
    )
    .run()
    .then((result) => result.meta.changes === 1);
};
