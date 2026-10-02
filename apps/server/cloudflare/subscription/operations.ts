import { pendingBillingWork } from "./internal/operational-observation";
import { type SubscriptionQueryInput } from "./contract";
import { executeProtectedSubscriptionQuery as observe } from "./internal/subscription-queries";

/** Observe one User's safe billing-derived standing with live credential and Audit checks at commit. */
export const executeProtectedSubscriptionQuery = (
  input: SubscriptionQueryInput
): Promise<Response> => observe(input);

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
