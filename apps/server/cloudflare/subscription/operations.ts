import { CanonicalAdmissionUnavailable } from "../canonical-admission/contract";
import { SqliteClient } from "@effect/sql-sqlite-do/SqliteClient";
import { SqlClient } from "effect/sql";

import { getSubscriptionStatus } from "../../src/shell/subscription/operations";
import { canonicalAdmissionUnavailable, runLocalMutation } from "../canonical-admission/operations";

import { withStoreCapacity } from "../runtime/sqlite/operations";
import type { LocalMutationResult } from "../canonical-admission/contract";
import {
  cancellationReview,
  dispatchCancellations as dispatchLocalCancellations,
  repairCancellationAlarm as inspectCancellation,
  retainCancellation,
} from "./internal/local-cancellation";
import { prepareBoundSubscriptionRead as prepareRead } from "./internal/bound-read";
import { cancellationRefusal, prepareCancellation } from "./internal/cancellation";
import type {
  CanonicalMutationPreparation,
  CanonicalMutationRefusal,
  CanonicalPreparationWork,
} from "../canonical-operations/contract";
import { claimSubscriptionRenewal } from "./internal/subscription-renewal";
import {
  type RefundAttempt,
  type RefundStartFailure,
  SubscriptionCancellation,
  SubscriptionOffers,
  SubscriptionStatus,
} from "../../src/core/subscription/contract";
import {
  type RefundReadCall,
  type RefundStartCall,
  RefundSupportAdmission,
  type SubscriptionQueryInput,
  SubscriptionRenewalAdmission,
  pricingName,
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

/** Prepare an idempotent same-User cancellation with its collection fence and accountability. */
export const prepareSubscriptionCancellation = (
  work: CanonicalPreparationWork
): Effect.Effect<CanonicalMutationPreparation> => prepareCancellation(work);
/** Closed refusal for absent paid standing under the caller's current authority. */
export const subscriptionCancellationRefusal = (
  work: CanonicalPreparationWork
): CanonicalMutationRefusal => cancellationRefusal(work);

export const prepareBoundSubscriptionRead: typeof prepareRead = (operation) =>
  prepareRead(operation);

export const retainSubscriptionCancellation: typeof retainCancellation = (input) =>
  retainCancellation(input);

export const offerDueSourceCancellations: typeof dispatchLocalCancellations = (input) =>
  dispatchLocalCancellations(input);

/** The canonical mutation kernel owns admission, live authority, accounting, Audit and the final receipt. */
export const cancelLocalSubscription = Effect.fnUntraced(function* (
  input: Parameters<typeof retainCancellation>[0]
) {
  const result = yield* retainCancellation(input);
  if (Option.isNone(result)) {
    const absent: LocalMutationResult = {
      status: 404,
      outcome: "not_found",
      body: {
        error: { code: "not_found", message: "No paid Subscription belongs to you." },
        next: [],
      },
    };
    return absent;
  }
  const data = yield* Schema.encodeEffect(SubscriptionCancellation)(result.value);
  const completed: LocalMutationResult = {
    status: 200,
    outcome: "success",
    body: { data, next: [] },
  };
  return completed;
});

export const repairCancellationAlarm = Effect.fnUntraced(function* (storage: DurableObjectStorage) {
  return yield* withStoreCapacity("required")(inspectCancellation(storage));
});

export const isLocalSubscriptionRead = (id: string): boolean =>
  [
    "subscription.listSubscriptionOffers",
    "subscription.getSubscriptionStatus",
    "subscription.getUpgradeUrl",
  ].includes(id);

export const readLocalSubscriptionOffers = Effect.fnUntraced(function* (
  pricing: Pick<DurableObjectNamespace, "getByName">
) {
  const response = yield* Effect.tryPromise(() =>
    pricing.getByName(pricingName).fetch("https://pricing.internal/offers")
  );
  if (!response.ok) {
    return yield* new CanonicalAdmissionUnavailable({ cause: "pricing_unavailable" });
  }
  return yield* Effect.tryPromise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(SubscriptionOffers)),
    Effect.flatMap(Schema.encodeEffect(SubscriptionOffers))
  );
});
export const readLocalSubscriptionStatus = Effect.fn(function* (
  user: Parameters<typeof getSubscriptionStatus>[0]
) {
  const { data } = yield* getSubscriptionStatus(user).pipe(
    Effect.provideService(SqlClient.SqlClient, yield* SqliteClient)
  );
  return yield* Schema.encodeEffect(Schema.toCodecJson(SubscriptionStatus))(data);
});
export const subscriptionReadResult = (data: Schema.Json): LocalMutationResult => ({
  status: 200,
  outcome: "success",
  body: { data, next: [] },
});
export const upgradeLocation = (origin: string): { url: string } => ({
  url: new URL("/upgrade", origin).href,
});

export const observeLocalSubscription = Effect.fn(
  function* (
    unit: Pick<
      Parameters<typeof runLocalMutation>[0],
      "owns" | "storage" | "request" | "operation"
    >,
    env: { PRICING: DurableObjectNamespace; BROWSER_ORIGIN: string }
  ) {
    const selection = unit.operation.id;
    const offers =
      selection === "subscription.listSubscriptionOffers"
        ? Option.some(yield* readLocalSubscriptionOffers(env.PRICING))
        : Option.none();
    return yield* runLocalMutation({
      ...unit,
      input: Effect.succeedSome(true),
      work: Effect.fn(function* (_, user) {
        if (Option.isSome(offers)) return subscriptionReadResult(offers.value);
        if (selection === "subscription.getUpgradeUrl") {
          return subscriptionReadResult(upgradeLocation(env.BROWSER_ORIGIN));
        }
        return subscriptionReadResult(yield* readLocalSubscriptionStatus(user));
      }),
    });
  },
  Effect.catchCause(() => Effect.succeed(canonicalAdmissionUnavailable()))
);

export const localCancellationReview: typeof cancellationReview = (user) =>
  cancellationReview(user);
