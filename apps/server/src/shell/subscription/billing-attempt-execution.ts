import { DateTime, Duration, Effect, Layer, Option, Result, Schema } from "effect";
import { PersistedQueue } from "effect/unstable/persistence";
import type { SqlClient } from "effect/unstable/sql";
import { Activity, DurableClock, Workflow, type WorkflowEngine } from "effect/unstable/workflow";
import { UserId } from "~/core/identity/reference";
import { amountInCentsForBilling } from "~/core/subscription/billing-rules";
import { BillingAttemptId, type WompiEnvironment } from "~/core/subscription/model";
import { BillingEmail } from "~/core/subscription/enrollment-model";
import { onboardingConsentStandingInScope, withSubjectLockInScope } from "~/shell/consent/repo";
import { withUserTransaction } from "~/shell/db/user-transaction";
import {
  type ArmedCharge,
  type BillingAttemptRecord,
  armBillingAttemptInScope,
  failBillingAttemptInScope,
  findBillingAttemptByIdInScope,
  findBillingTransactionsInScope,
  markBillingAttemptAwaitingReferenceInScope,
  markBillingAttemptManualReconciliationInScope,
  recordBillingTransactionInScope,
} from "./billing-repo";
import {
  WompiBillingClient,
  type WompiBillingClientService,
  type WompiTransaction,
} from "./wompi-billing-client";
import { reconcileWompiSettlement } from "./wompi-settlement";

/** Identifier-only durable Work for one pending BillingAttempt; the worker re-reads owner state. */
export const BillingAttemptReconciliationPayload = Schema.Struct({
  userId: UserId,
  billingAttemptId: BillingAttemptId,
  revision: Schema.Literal(1).pipe(Schema.withDecodingDefaultKey(Effect.succeed(1 as const))),
}).annotate({ identifier: "BillingAttemptReconciliationPayload" });
export type BillingAttemptReconciliationPayload = typeof BillingAttemptReconciliationPayload.Type;

/** The provider has spoken, or Fidy has explicitly handed the attempt to an operator. */
export const BillingAttemptReconciliationSuccess = Schema.Struct({
  outcome: Schema.Literals([
    "succeeded",
    "failed",
    "awaiting-provider-reference",
    "manual-reconciliation-required",
    "not-current",
  ]),
}).annotate({ identifier: "BillingAttemptReconciliationSuccess" });
export type BillingAttemptReconciliationSuccess = typeof BillingAttemptReconciliationSuccess.Type;

/** One durable loop per BillingAttempt, independent of queue redelivery and concurrent settlement. */
export const BillingAttemptReconciliationWorkflow = Workflow.make("BillingAttemptReconciliation", {
  payload: BillingAttemptReconciliationPayload,
  success: BillingAttemptReconciliationSuccess,
  error: Schema.Never,
  idempotencyKey: ({ billingAttemptId }) => billingAttemptId,
});

/** Transactional acceptance handoff; one queue item per BillingAttempt identity. */
const billingAttemptQueue = PersistedQueue.make({
  name: "subscription-billing-attempt",
  schema: BillingAttemptReconciliationPayload,
});

/** Publishes reconciliation Work in the same SQL transaction that creates the BillingAttempt. */
export const publishBillingAttemptInScope = Effect.fn("Subscription.publishBillingAttemptInScope")(
  function* (job: Readonly<{ userId: UserId; billingAttemptId: BillingAttemptId }>) {
    const queue = yield* billingAttemptQueue;
    yield* queue
      .offer(
        { userId: job.userId, billingAttemptId: job.billingAttemptId, revision: 1 },
        { id: job.billingAttemptId }
      )
      .pipe(Effect.orDie);
  }
);

/** One iteration's durable observation of the owning BillingAttempt before any wait. */
const ReconciliationDisposition = Schema.Union([
  Schema.TaggedStruct("Settled", { status: Schema.Literals(["succeeded", "failed"]) }),
  Schema.TaggedStruct("Tracked", { since: Schema.DateTimeUtcFromString }),
  Schema.TaggedStruct("AwaitingReference", {}),
  Schema.TaggedStruct("NotCurrent", {}),
]);
type ReconciliationDisposition = typeof ReconciliationDisposition.Type;

const maximumBackoffExponent = 4;
const maximumReconciliationDelay: Duration.Input = "15 minutes";
const manualReconciliationAge: Duration.Input = "7 days";

const reconciliationDelayFor = (baseDelay: Duration.Input, attempt: number): Duration.Duration =>
  Duration.millis(
    Math.min(
      Duration.toMillis(baseDelay) * 2 ** Math.min(attempt - 1, maximumBackoffExponent),
      Duration.toMillis(maximumReconciliationDelay)
    )
  );

type ReconciliationEscalation = Extract<
  BillingAttemptReconciliationSuccess["outcome"],
  "awaiting-provider-reference" | "manual-reconciliation-required"
>;

const warnOperationalEscalation = (
  outcome: ReconciliationEscalation,
  message: string
): Effect.Effect<void> =>
  Effect.logWarning(message).pipe(
    Effect.annotateLogs({ work_kind: "billing-reconciliation", outcome })
  );

/** Ends this wake awaiting a provider identity; an operator reconciles the armed charge. */
const awaitProviderReference = Effect.fn("Subscription.awaitBillingProviderReference")(function* (
  userId: UserId,
  billingAttemptId: BillingAttemptId
) {
  yield* withUserTransaction(
    userId,
    markBillingAttemptAwaitingReferenceInScope(userId, billingAttemptId, yield* DateTime.now)
  );
  return { _tag: "AwaitingReference" } as const;
});

/** Observes every unresolved provider transaction retained under one already-armed attempt. */
const observeChargedAttempt = Effect.fn("Subscription.observeChargedBillingAttempt")(function* (
  userId: UserId,
  billing: WompiBillingClientService,
  attempt: BillingAttemptRecord
) {
  const since = Option.getOrElse(Option.fromNullOr(attempt.armedAt), () => attempt.createdAt);
  const transactions = yield* withUserTransaction(
    userId,
    findBillingTransactionsInScope(userId, attempt.id)
  );
  if (transactions.length === 0) return yield* awaitProviderReference(userId, attempt.id);
  const unresolved = transactions.filter((transaction) => transaction.status !== "APPROVED");
  for (const transaction of unresolved) {
    const lookup = yield* billing.findTransaction(transaction.transactionId).pipe(Effect.result);
    if (Result.isFailure(lookup) || lookup.success.status === "PENDING") continue;
    yield* reconcileWompiSettlement({
      provider: lookup.success,
      environment: billing.environment,
      observedAt: yield* DateTime.now,
    }).pipe(
      // A retained transaction id is authoritative; a mismatch is a defect we surface and retry,
      // never a reason to fabricate a terminal outcome.
      Effect.catchTag("MismatchedWompiEvidence", () =>
        Effect.logError("Wompi reconciliation evidence did not match its retained attempt").pipe(
          Effect.annotateLogs({ work_kind: "billing-reconciliation" })
        )
      )
    );
  }
  // No supported writer leaves a pending attempt whose retained transactions are all APPROVED
  // (settlement succeeds the attempt in the same transaction as the approval). Keep tracking so an
  // inconsistency escalates to an operator rather than fabricating a paid period from stale rows.
  const settled = yield* withUserTransaction(
    userId,
    findBillingAttemptByIdInScope(userId, attempt.id)
  );
  if (Option.isNone(settled)) return { _tag: "NotCurrent" } as const;
  if (settled.value.status === "succeeded") {
    return { _tag: "Settled", status: "succeeded" } as const;
  }
  if (settled.value.status === "failed") {
    return { _tag: "Settled", status: "failed" } as const;
  }
  return { _tag: "Tracked", since } as const;
});

/** Arms the attempt under the Consent ordering lock; a revoked Consent returns no charge. */
const armBillingAttemptWithConsent = Effect.fn("Subscription.armBillingAttemptWithConsent")(
  function* (userId: UserId, billingAttemptId: BillingAttemptId, armedAt: DateTime.Utc) {
    return yield* withUserTransaction(
      userId,
      withSubjectLockInScope(
        userId,
        Effect.gen(function* () {
          if ((yield* onboardingConsentStandingInScope(userId)) !== "granted") {
            return Option.none();
          }
          return yield* armBillingAttemptInScope(userId, billingAttemptId, armedAt);
        })
      )
    );
  }
);

/** Retains the provider's create response as the attempt's first observed transaction. */
const recordCreatedBillingTransaction = Effect.fn("Subscription.recordCreatedBillingTransaction")(
  function* (input: {
    userId: UserId;
    attempt: ArmedCharge;
    transaction: WompiTransaction;
    environment: WompiEnvironment;
  }) {
    yield* withUserTransaction(
      input.userId,
      recordBillingTransactionInScope(
        {
          userId: input.userId,
          billingAttemptId: input.attempt.billingAttemptId,
          transactionId: input.transaction.transactionId,
          status: input.transaction.status,
          amountInCents: input.transaction.amountInCents,
          currency: input.transaction.currency,
          wompiSourceId: input.transaction.sourceId,
          wompiEnvironment: input.environment,
          finalizedAt: input.transaction.finalizedAt,
          observedAt: yield* DateTime.now,
        },
        Option.some(input.attempt.reference)
      )
    );
  }
);

/**
 * Arms one provider mutation exactly once. A definitive provider rejection fails the attempt; an
 * armed attempt whose provider answer is lost or created under another reference is recorded as
 * awaiting a provider reference and never re-sent.
 */
const chargeBillingAttempt = Effect.fn("Subscription.chargeBillingAttempt")(function* (
  payload: BillingAttemptReconciliationPayload,
  billing: WompiBillingClientService
) {
  const armedAt = yield* DateTime.now;
  const armed = yield* armBillingAttemptWithConsent(
    payload.userId,
    payload.billingAttemptId,
    armedAt
  );
  if (Option.isNone(armed)) {
    // Revoked Consent stops the charge; a concurrent arm leaves the attempt to reconciliation.
    const reread = yield* withUserTransaction(
      payload.userId,
      findBillingAttemptByIdInScope(payload.userId, payload.billingAttemptId)
    );
    if (Option.isNone(reread) || reread.value.chargeState === "queued") {
      return { _tag: "NotCurrent" } as const;
    }
    return yield* observeChargedAttempt(payload.userId, billing, reread.value);
  }
  const response = yield* billing
    .createTransaction({
      reference: armed.value.reference,
      amountInCents: yield* amountInCentsForBilling(armed.value.amount),
      currency: armed.value.currency,
      billingEmail: BillingEmail.make(armed.value.billingEmail),
      sourceId: armed.value.wompiSourceId,
    })
    .pipe(Effect.result);
  if (Result.isFailure(response)) {
    if (response.failure.certainty === "rejected") {
      // Wompi refused to create any transaction under this reference, so nothing is collectable.
      yield* withUserTransaction(
        payload.userId,
        failBillingAttemptInScope(payload.userId, payload.billingAttemptId, yield* DateTime.now)
      );
      return { _tag: "Settled", status: "failed" } as const;
    }
    return yield* awaitProviderReference(payload.userId, payload.billingAttemptId);
  }
  if (response.success.reference !== armed.value.reference) {
    // A transaction created under another reference may exist; never re-send, ask an operator.
    return yield* awaitProviderReference(payload.userId, payload.billingAttemptId);
  }
  yield* recordCreatedBillingTransaction({
    userId: payload.userId,
    attempt: armed.value,
    transaction: response.success,
    environment: billing.environment,
  });
  // Wait before the first provider lookup; the next wake re-reads authoritative state.
  return { _tag: "Tracked", since: armedAt } as const;
});

/** Re-reads the owner on every wake before deciding the next durable step. */
const reconcileBillingAttemptOnce = Effect.fn("Subscription.reconcileBillingAttemptOnce")(
  function* (payload: BillingAttemptReconciliationPayload) {
    const billing = yield* WompiBillingClient;
    const current = yield* withUserTransaction(
      payload.userId,
      findBillingAttemptByIdInScope(payload.userId, payload.billingAttemptId)
    );
    if (Option.isNone(current)) return { _tag: "NotCurrent" } as const;
    if (current.value.status !== "pending") {
      return { _tag: "Settled", status: current.value.status } as const;
    }
    if (current.value.chargeState === "queued") {
      return yield* chargeBillingAttempt(payload, billing);
    }
    return yield* observeChargedAttempt(payload.userId, billing, current.value);
  }
);

const markManualReconciliation = Effect.fn("Subscription.markManualBillingReconciliation")(
  function* (payload: BillingAttemptReconciliationPayload, observedAt: DateTime.Utc) {
    yield* withUserTransaction(
      payload.userId,
      markBillingAttemptManualReconciliationInScope(
        payload.userId,
        payload.billingAttemptId,
        observedAt
      )
    );
  }
);

/**
 * Builds the reconciliation workflow registration with a testable base backoff. Each wake is a fresh
 * owner read behind a durable clock; a known PENDING transaction is re-checked on a bounded backoff
 * and never gives up. An unresolved provider outcome is escalated for manual reconciliation, never
 * silently stopped. Terminal workflow and queue history cleanup is deferred to #468/#471; this change
 * adds no billing retention loop.
 */
export const billingAttemptReconciliationWorkflowLayer = (
  baseDelay: Duration.Input
): Layer.Layer<
  never,
  never,
  SqlClient.SqlClient | WompiBillingClient | WorkflowEngine.WorkflowEngine
> =>
  BillingAttemptReconciliationWorkflow.toLayer(
    Effect.fn("Subscription.runBillingAttemptReconciliation")(function* (
      payload: BillingAttemptReconciliationPayload
    ) {
      for (let attempt = 1; ; attempt++) {
        const disposition = yield* Activity.make({
          name: "ReconcileBillingAttempt",
          success: ReconciliationDisposition,
          execute: reconcileBillingAttemptOnce(payload),
        }).pipe(Effect.provideService(Activity.CurrentAttempt, attempt));
        switch (disposition._tag) {
          case "NotCurrent":
            return { outcome: "not-current" as const };
          case "AwaitingReference":
            yield* warnOperationalEscalation(
              "awaiting-provider-reference",
              "BillingAttempt is armed with no provider reference and needs operator reconciliation"
            );
            return { outcome: "awaiting-provider-reference" as const };
          case "Settled":
            return { outcome: disposition.status };
          case "Tracked": {
            const now = yield* DateTime.now;
            const trackedFor = DateTime.distance(disposition.since, now);
            if (Duration.toMillis(trackedFor) >= Duration.toMillis(manualReconciliationAge)) {
              yield* Activity.make({
                name: "EscalateBillingAttemptReconciliation",
                success: Schema.Void,
                execute: markManualReconciliation(payload, now),
              }).pipe(Effect.provideService(Activity.CurrentAttempt, attempt));
              yield* warnOperationalEscalation(
                "manual-reconciliation-required",
                "BillingAttempt provider outcome has not resolved and needs operator reconciliation"
              );
              return { outcome: "manual-reconciliation-required" as const };
            }
            yield* DurableClock.sleep({
              name: `BillingAttemptReconciliationWait/${attempt}`,
              duration: reconciliationDelayFor(baseDelay, attempt),
              inMemoryThreshold: "0 millis",
            });
          }
        }
      }
    })
  );

/** Production reconciliation cadence: one minute, doubling to a fifteen-minute cap. */
export const BillingAttemptReconciliationWorkflowLive =
  billingAttemptReconciliationWorkflowLayer("1 minute");

/** Starts one transactionally accepted reconciliation without holding a queue lease for its lifetime. */
export const BillingAttemptQueueLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const queue = yield* billingAttemptQueue;
    yield* queue
      .take((payload) =>
        BillingAttemptReconciliationWorkflow.execute(payload, { discard: true }).pipe(Effect.asVoid)
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logError("BillingAttempt reconciliation submission failed", cause)
        ),
        Effect.forever,
        Effect.forkScoped
      );
  })
);

/** Registers the workflow and consumes its native queue; an armed redelivery never resends Wompi. */
export const BillingAttemptWorkerLive = Layer.mergeAll(
  BillingAttemptReconciliationWorkflowLive,
  BillingAttemptQueueLive
);
