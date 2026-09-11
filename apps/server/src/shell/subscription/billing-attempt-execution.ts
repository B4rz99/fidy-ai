import { Data, DateTime, Effect, Layer, Option, Schema } from "effect";
import { PersistedQueue } from "effect/unstable/persistence";
import { UserId } from "~/core/identity/reference";
import { BillingAttemptId } from "~/core/subscription/model";
import { amountInCentsForBilling } from "~/core/subscription/billing-rules";
import { BillingEmail } from "~/core/subscription/enrollment-model";
import { onboardingConsentStandingInScope, withSubjectLockInScope } from "~/shell/consent/repo";
import { withUserTransaction } from "~/shell/db/user-transaction";
import {
  type BillingAttemptRecord,
  armBillingAttemptInScope,
  findBillingAttemptByIdInScope,
  recordCreatedWompiTransactionInScope,
} from "./billing-repo";
import { WompiBillingClient, type WompiBillingClientService } from "./wompi-billing-client";
import { reconcileWompiSettlement } from "./wompi-settlement";

const BillingAttemptWork = Schema.Struct({ userId: UserId, billingAttemptId: BillingAttemptId });
const queueName = "subscription-billing-attempt";
const reconciliationDelay = "1 minute";
const maximumReconciliationAttempts = 10;
const complete = "complete" as const;
const awaitEvidence = "await-evidence" as const;
export const billingAttemptQueue = PersistedQueue.make({
  name: queueName,
  schema: BillingAttemptWork,
});

class BillingAttemptAwaitingEvidence extends Data.TaggedError(
  "BillingAttemptAwaitingEvidence"
)<{}> {}

/** Publishes provider Work in the same SQL transaction that creates the BillingAttempt. */
export const publishBillingAttemptInScope = Effect.fn("Subscription.publishBillingAttemptInScope")(
  function* (job: typeof BillingAttemptWork.Type) {
    const queue = yield* billingAttemptQueue;
    yield* queue.offer(job, { id: job.billingAttemptId }).pipe(Effect.orDie);
  }
);

const waitForEvidence: Effect.Effect<never, BillingAttemptAwaitingEvidence> = Effect.sleep(
  reconciliationDelay
).pipe(Effect.andThen(Effect.fail(new BillingAttemptAwaitingEvidence())));

const reconcileArmedBillingAttempt = Effect.fn("Subscription.reconcileArmedBillingAttempt")(
  function* (billing: WompiBillingClientService, attempt: BillingAttemptRecord) {
    if (attempt.wompiTransactionId === null) return awaitEvidence;
    const lookup = yield* billing.findTransaction(attempt.wompiTransactionId).pipe(Effect.result);
    if (lookup._tag === "Failure" || lookup.success.status === "PENDING") return awaitEvidence;
    yield* reconcileWompiSettlement({
      provider: lookup.success,
      environment: billing.environment,
      observedAt: yield* DateTime.now,
    });
    return complete;
  }
);

const executeBillingAttemptWithConsent = Effect.fn("Subscription.executeBillingAttemptWithConsent")(
  function* (job: typeof BillingAttemptWork.Type) {
    const billing = yield* WompiBillingClient;
    const attempt = yield* withUserTransaction(
      job.userId,
      findBillingAttemptByIdInScope(job.userId, job.billingAttemptId)
    );
    if (Option.isNone(attempt)) return complete;
    if (attempt.value.chargeState === "armed") {
      return yield* reconcileArmedBillingAttempt(billing, attempt.value);
    }
    const armed = yield* withUserTransaction(
      job.userId,
      withSubjectLockInScope(
        job.userId,
        Effect.gen(function* () {
          if ((yield* onboardingConsentStandingInScope(job.userId)) !== "granted") {
            return Option.none();
          }
          return yield* armBillingAttemptInScope(
            job.userId,
            job.billingAttemptId,
            yield* DateTime.now
          );
        })
      )
    );
    if (Option.isNone(armed)) return complete;
    const response = yield* billing
      .createTransaction({
        reference: armed.value.reference,
        amountInCents: yield* amountInCentsForBilling(armed.value.amount),
        currency: armed.value.currency,
        billingEmail: BillingEmail.make(armed.value.billingEmail),
        sourceId: armed.value.wompiSourceId,
      })
      .pipe(Effect.result);
    if (response._tag === "Failure" || response.success.reference !== armed.value.reference) {
      return awaitEvidence;
    }
    yield* withUserTransaction(
      job.userId,
      recordCreatedWompiTransactionInScope({
        userId: job.userId,
        billingAttemptId: job.billingAttemptId,
        transactionId: response.success.transactionId,
        reference: response.success.reference,
      })
    );
    return awaitEvidence;
  }
);

const executeBillingAttempt = Effect.fn("Subscription.executeBillingAttempt")(function* (
  job: typeof BillingAttemptWork.Type
) {
  const disposition = yield* executeBillingAttemptWithConsent(job);
  if (disposition === awaitEvidence) return yield* waitForEvidence;
});

export const consumeBillingAttempts = Effect.gen(function* () {
  const queue = yield* billingAttemptQueue;
  return yield* queue
    .take((job) => executeBillingAttempt(job), { maxAttempts: maximumReconciliationAttempts })
    .pipe(
      Effect.catchTag("BillingAttemptAwaitingEvidence", () => Effect.void),
      Effect.catchCause((cause) => Effect.logError("BillingAttempt iteration failed", cause)),
      Effect.forever
    );
});

/** Owns durable first-charge delivery; an armed redelivery reconciles but never resends Wompi. */
export const BillingAttemptWorkerLive = Layer.effectDiscard(
  consumeBillingAttempts.pipe(Effect.forkScoped)
);
