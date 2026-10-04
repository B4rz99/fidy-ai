import { Clock, Data, Effect, Option, Schema } from "effect";
import type { CoreQueueEnvironment, CoreQueueHandler } from "../contract";
import {
  isBrowserPairingEmailWork,
  isEmailReplacementWork,
  receiveBrowserPairingEmail,
  receiveEmailReplacement,
  receiveOnboardingEmail,
} from "../../email-authentication/runtime";
import { receiveCanary } from "../../runtime/operational-health/operations";
import { receiveSmoke, smokeReady } from "../../runtime/release-smoke/operations";
import {
  isForwardedEmailWork,
  isStatementExtractionWork,
  receiveForwardedEmailWork,
  receiveStatementExtraction,
} from "../../ingestion/runtime";
import { WhatsAppWork } from "../../whatsapp/contract";
import { receiveWhatsAppWork } from "../../whatsapp/runtime";
import {
  isBillingCollectionWork,
  isRefundWork,
  receiveBillingCollection,
  receiveRefunds,
} from "../../subscription/runtime";

const receiveEmailQueue: CoreQueueHandler = (batch, environment) => {
  if (batch.messages.some((message) => isEmailReplacementWork(message.body))) {
    if (environment.EMAIL_REPLACEMENT_WORKFLOW === undefined) {
      return Promise.reject(new Error("Email replacement unavailable"));
    }
    return receiveEmailReplacement({
      DB: environment.DB,
      EMAIL_REPLACEMENT_WORKFLOW: environment.EMAIL_REPLACEMENT_WORKFLOW,
    })(batch).pipe(Effect.withSpan("emailReplacement.receive"), Effect.runPromise);
  }
  if (batch.messages.some((message) => isBrowserPairingEmailWork(message.body))) {
    if (environment.BROWSER_PAIRING_EMAIL_WORKFLOW === undefined) {
      return Promise.reject(new Error("Browser pairing email unavailable"));
    }
    return receiveBrowserPairingEmail({
      DB: environment.DB,
      BROWSER_PAIRING_EMAIL_WORKFLOW: environment.BROWSER_PAIRING_EMAIL_WORKFLOW,
    })(batch).pipe(Effect.runPromise);
  }
  if (
    environment.ONBOARDING_EMAIL_QUEUE === undefined ||
    environment.ONBOARDING_EMAIL_WORKFLOW === undefined ||
    environment.RESEND_API_KEY === undefined
  ) {
    return Promise.reject(new Error("Onboarding email unavailable"));
  }
  return receiveOnboardingEmail({
    DB: environment.DB,
    ONBOARDING_EMAIL_WORKFLOW: environment.ONBOARDING_EMAIL_WORKFLOW,
  })(batch).pipe(Effect.runPromise);
};

const receiveCanaryBatch: CoreQueueHandler = (batch, environment) => {
  const message = batch.messages[0];
  if (
    batch.messages.length !== 1 ||
    message === undefined ||
    environment.OPERATIONAL_CANARY_WORKFLOW === undefined
  ) {
    return Promise.reject(new Error("Operational canary unavailable"));
  }
  return receiveCanary({
    DB: environment.DB,
    workflow: environment.OPERATIONAL_CANARY_WORKFLOW,
    payload: message.body,
    now: Effect.runSync(Clock.currentTimeMillis),
  });
};

const receiveReservedSmoke = (
  batch: MessageBatch<unknown>,
  environment: CoreQueueEnvironment
): Option.Option<Promise<void>> => {
  if (environment.SMOKE_QUEUE_NAME === undefined || batch.queue !== environment.SMOKE_QUEUE_NAME) {
    return Option.none();
  }
  return Option.some(
    smokeReady(environment)
      ? receiveSmoke({ batch, environment })
      : Promise.reject(new Error("Smoke wiring unavailable"))
  );
};

const receiveForwardedQueue = (
  batch: MessageBatch<unknown>,
  environment: CoreQueueEnvironment
): Promise<void> => {
  if (environment.EMAIL_BUCKET === undefined) {
    return Promise.reject(new Error("Email evidence unavailable"));
  }
  return Effect.tryPromise({
    try: () =>
      receiveForwardedEmailWork({
        messages: batch.messages,
        coordinator: environment.USER_TRANSACTION_COORDINATOR,
      }),
    catch: () => new ForwardedEmailDeliveryUnavailable(),
  }).pipe(Effect.withSpan("ingestion.forwarded-email.queue"), Effect.runPromise);
};

const receiveBillingQueue: CoreQueueHandler = (batch, environment) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const refunds = batch.messages.filter((message) => isRefundWork(message.body));
      const charges = batch.messages.filter((message) => isBillingCollectionWork(message.body));
      if (refunds.length + charges.length !== batch.messages.length) {
        return yield* Effect.fail("Invalid billing work");
      }
      if (refunds.length > 0) {
        if (environment.BILLING_REFUND_WORKFLOW === undefined) {
          return yield* Effect.fail("Billing refunds unavailable");
        }
        yield* receiveRefunds({
          environment: { BILLING_REFUND_WORKFLOW: environment.BILLING_REFUND_WORKFLOW },
          batch: { messages: refunds },
        });
      }
      if (charges.length > 0) {
        if (environment.BILLING_COLLECTION_WORKFLOW === undefined) {
          return yield* Effect.fail("Billing collection unavailable");
        }
        yield* receiveBillingCollection({
          environment: {
            DB: environment.DB,
            BILLING_COLLECTION_WORKFLOW: environment.BILLING_COLLECTION_WORKFLOW,
          },
          batch: { messages: charges },
        });
      }
    })
  );

const receiveWorkQueue: CoreQueueHandler = (batch, environment) => {
  const smoke = receiveReservedSmoke(batch, environment);
  if (Option.isSome(smoke)) return smoke.value;
  if (batch.messages.some((message) => Schema.is(WhatsAppWork)(message.body))) {
    return receiveWhatsAppWork({
      messages: batch.messages,
      coordinator: environment.USER_TRANSACTION_COORDINATOR,
    });
  }
  if (batch.messages.some((message) => isForwardedEmailWork(message.body))) {
    return receiveForwardedQueue(batch, environment);
  }
  if (batch.messages.some((message) => isStatementExtractionWork(message.body))) {
    if (environment.STATEMENT_EXTRACTION_WORKFLOW === undefined) {
      return Promise.reject(new Error("Statement extraction unavailable"));
    }
    return receiveStatementExtraction({
      environment: {
        DB: environment.DB,
        STATEMENT_EXTRACTION_WORKFLOW: environment.STATEMENT_EXTRACTION_WORKFLOW,
      },
      messages: batch.messages,
    }).pipe(Effect.runPromise);
  }
  return batch.messages.some(
    (message) => isBillingCollectionWork(message.body) || isRefundWork(message.body)
  )
    ? receiveBillingQueue(batch, environment)
    : receiveEmailQueue(batch, environment);
};

/** Queue redelivery exposes no receipt, User, or provider details on failure. */
class ForwardedEmailDeliveryUnavailable extends Data.TaggedError(
  "ForwardedEmailDeliveryUnavailable"
) {}

/** Preserve the native Queue selection order; payload validation and acknowledgment stay owner-held. */
export const dispatchCoreQueue = ({
  batch,
  environment,
}: Readonly<{
  batch: MessageBatch<unknown>;
  environment: CoreQueueEnvironment;
}>): Promise<void> =>
  batch.queue === environment.OPERATIONAL_CANARY_QUEUE_NAME
    ? receiveCanaryBatch(batch, environment)
    : receiveWorkQueue(batch, environment);
