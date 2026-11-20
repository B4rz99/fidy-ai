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

export const claimPreparedPaymentEnrollment = ({
  db,
  input,
  claimedAtMs,
  authorityGuard,
}: Readonly<{
  db: D1Database;
  input: typeof Claim.Type;
  claimedAtMs: number;
  authorityGuard: OwnedStatement;
}>): Promise<boolean> => {
  const claim = Schema.decodeSync(Claim)(input);
  return db
    .prepare(`UPDATE payment_enrollments SET status = 'creating',
      payment_request_id = ?, accepted_at_ms = ?, authorization_digest = ?, billing_email = ?
    WHERE id = ? AND subscription_id = (SELECT id FROM subscriptions WHERE user_id = ?) AND status = 'prepared' AND expires_at_ms > ?
      AND payment_source_mode = ?
      AND (payment_source_mode = 'create' OR billing_email = ?)
      AND EXISTS (${authorityGuard.sql})`)
    .bind(
      claim.paymentRequestId,
      claimedAtMs,
      claim.authorizationDigest ?? null,
      claim.billingEmail,
      claim.enrollmentId,
      claim.userId,
      claimedAtMs,
      claim.paymentSourceMode,
      claim.billingEmail,
      ...authorityGuard.params
    )
    .run()
    .then((result) => result.meta.changes === 1);
};
