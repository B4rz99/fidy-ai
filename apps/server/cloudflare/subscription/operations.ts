import { claimSubscriptionRenewal } from "./internal/subscription-renewal";
import {
  Price,
  type RefundAttempt,
  type RefundStartFailure,
} from "../../src/core/subscription/contract";
import {
  BillingCollectionFailure,
  type RefundReadCall,
  type RefundStartCall,
  RefundSupportAdmission,
  type SubscriptionQueryInput,
  SubscriptionRenewalAdmission,
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

/** Admit an automatic renewal under explicit same-User coordination and live billing authority. */
export const executeSubscriptionRenewalAdmission = (
  input: Readonly<{
    db: D1Database;
    userId: string;
    environment: string;
    candidate: unknown;
    now: number;
  }>
): Effect.Effect<Response> => {
  const work = Schema.decodeUnknownOption(SubscriptionRenewalAdmission)(input.candidate);
  if (Option.isNone(work) || work.value.userId !== input.userId) {
    return Effect.succeed(new Response(null, { status: 403 }));
  }
  return claimSubscriptionRenewal({ ...input, ...work.value }).pipe(
    Effect.as(new Response(null, { status: 202 })),
    Effect.orElseSucceed(() => new Response(null, { status: 503 }))
  );
};

/** Trusted operator publication: freezes replacement terms and records affected Users' notice intent atomically. */
export const publishWeeklyPrice = (
  input: Readonly<{ db: D1Database; price: Price }>
): Effect.Effect<void, BillingCollectionFailure> =>
  Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(Price)(input.price).pipe(
      Effect.mapError((cause) => new BillingCollectionFailure({ cause: Option.some(cause) }))
    );
    if (encoded.billingPeriod !== "weekly") {
      return yield* new BillingCollectionFailure({ cause: Option.none() });
    }
    const terms = yield* Schema.encodeEffect(
      Schema.fromJsonString(
        Schema.Struct({
          ...Price.fields.renewalTerms.fields,
          paymentMethods: Price.fields.paymentMethods,
        })
      )
    )({ ...input.price.renewalTerms, paymentMethods: input.price.paymentMethods }).pipe(
      Effect.mapError((cause) => new BillingCollectionFailure({ cause: Option.some(cause) }))
    );
    yield* Effect.tryPromise({
      try: () =>
        input.db.batch([
          input.db
            .prepare(`INSERT INTO subscription_prices
      (id, amount, currency, billing_period, service_market, tax_treatment, terms_json, published_order)
      VALUES (?, ?, ?, 'weekly', ?, ?, ?, NULL)`)
            .bind(
              encoded.id,
              encoded.money.amount,
              encoded.money.currency,
              encoded.serviceMarket,
              encoded.taxTreatment,
              terms
            ),
          input.db.prepare(
            "UPDATE subscription_prices SET published_order = NULL WHERE published_order = 1"
          ),
          input.db
            .prepare("UPDATE subscription_prices SET published_order = 1 WHERE id = ?")
            .bind(encoded.id),
        ]),
      catch: (cause) => new BillingCollectionFailure({ cause: Option.some(cause) }),
    });
  });
