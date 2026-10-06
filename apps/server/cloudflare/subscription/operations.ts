import { type RefundAttempt, type RefundStartFailure } from "../../src/core/subscription/contract";
import {
  type RefundReadCall,
  type RefundStartCall,
  RefundSupportAdmission,
  type SubscriptionQueryInput,
  refundSupportBasePath,
  refundSupportReadPath,
} from "./contract";
import { Effect, Option, Schema } from "effect";
import { refundFailureResponse, refundResultResponse } from "./internal/refund-http-response";
import {
  startRefund as acceptRefund,
  getRefund as observeRefund,
} from "./internal/refund-acceptance";

import { queryUpgrade } from "./internal/upgrade-query";
import { pendingBillingWork } from "./internal/operational-observation";
import { executeProtectedSubscriptionQuery as observe } from "./internal/subscription-queries";

/** Accept support intent atomically, reserving exact Money and versioned execution work. */
export const startRefund = (
  call: RefundStartCall
): Effect.Effect<RefundAttempt, RefundStartFailure> => acceptRefund(call);
/** Read a User-scoped correction without exposing provider or operator evidence. */
export const getRefund = (call: RefundReadCall): Effect.Effect<RefundAttempt, RefundStartFailure> =>
  observeRefund(call);

/** Closed support routing is intentionally outside canonical/PAT/model write capabilities. */
export const refundSupportRoute = (path: string): boolean =>
  path === refundSupportBasePath || refundSupportReadPath.test(path);

/** The User coordinator rechecks scope and the live support admission before committing intent. */
export const executeRefundSupportAdmission = (
  input: Readonly<{
    db: D1Database;
    environment: string;
    candidate: unknown;
    userId: string;
  }>
): Effect.Effect<Response> => {
  const admission = Schema.decodeUnknownOption(RefundSupportAdmission)(input.candidate);
  if (Option.isNone(admission) || admission.value.input.userId !== input.userId) {
    return Effect.succeed(refundFailureResponse("unsupported"));
  }
  return refundResultResponse({
    status: 202,
    result: acceptRefund({
      db: input.db,
      environment: input.environment,
      authority: admission.value.authority,
      input: admission.value.input,
    }),
  });
};

/** Observe one User's safe billing-derived standing with live credential and Audit checks at commit. */
export const executeProtectedSubscriptionQuery = (
  input: SubscriptionQueryInput
): Effect.Effect<Response> =>
  input.operation === "subscription.getUpgradeUrl" ? queryUpgrade(input) : observe(input);

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
