import { pendingBillingWork } from "./internal/operational-observation";
import { type EnrollmentEnvironment, type SubscriptionQueryInput } from "./contract";
import { handleCardEnrollment as enroll } from "./internal/card-enrollment";
import { executeProtectedSubscriptionQuery as observe } from "./internal/subscription-queries";

/** Observe one User's safe billing-derived standing with live credential and Audit checks at commit. */
export const executeProtectedSubscriptionQuery = (
  input: SubscriptionQueryInput
): Promise<Response> => observe(input);

/** Fresh-session browser enrollment; provider references and transient card material remain private. */
export const handleCardEnrollment = (
  input: Readonly<{ request: Request; environment: EnrollmentEnvironment }>
): Promise<Response> => enroll(input);

/**
 * Observe the oldest at-most-eight pending BillingAttempt identities and creation times for private
 * operational health. The id/created/deadline projection contains no User or financial payload.
 */
export const prepareBillingWorkObservation = (
  input: Readonly<{
    db: D1Database;
    limit: number;
  }>
): D1PreparedStatement => pendingBillingWork(input);
