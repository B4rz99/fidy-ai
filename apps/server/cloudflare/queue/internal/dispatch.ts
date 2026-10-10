import { ProactivityDeliveryWork } from "../../insights/contract";
import { receiveProactivityWork } from "../../insights/runtime";
import { Cause, Clock, Data, Effect, Exit, Option, Schema } from "effect";
import type { CoreQueueEnvironment } from "../contract";
import {
  isBrowserPairingEmailWork,
  isEmailReplacementWork,
  receiveBrowserPairingEmail,
  receiveEmailReplacement,
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

/** Retain a native rejection privately; the runtime unwraps it after closed telemetry observation. */
export class QueueDeliveryUnavailable extends Data.TaggedError("QueueDeliveryUnavailable")<{
  readonly original: unknown;
}> {}
class ForwardedEmailDeliveryUnavailable extends Data.TaggedError(
  "ForwardedEmailDeliveryUnavailable"
) {}
const deliveryFailure = (original: unknown): QueueDeliveryUnavailable =>
  original instanceof QueueDeliveryUnavailable
    ? original
    : new QueueDeliveryUnavailable({ original });
type QueueInput = Readonly<{ batch: MessageBatch<unknown>; environment: CoreQueueEnvironment }>;
const nativeDelivery = (work: () => Promise<void>): Effect.Effect<void, QueueDeliveryUnavailable> =>
  Effect.tryPromise({ try: work, catch: deliveryFailure });

const receiveWorkflowBatch = <E>(
  batch: MessageBatch<unknown>,
  receive: (message: MessageBatch<unknown>) => Effect.Effect<void, E>
): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    let failure = Option.none<Cause.Cause<E>>();
    for (const message of batch.messages) {
      const result = yield* Effect.exit(
        receive({
          queue: batch.queue,
          metadata: batch.metadata,
          messages: [message],
          ackAll: () => message.ack(),
          retryAll: (options) => message.retry(options),
        })
      );
      if (Exit.isFailure(result)) {
        if (Cause.hasInterrupts(result.cause)) return yield* Effect.failCause(result.cause);
        if (Option.isNone(failure)) failure = Option.some(result.cause);
      }
    }
    // Owner acknowledgments fence successful handoffs from this final batch rejection.
    if (Option.isSome(failure)) return yield* Effect.failCause(failure.value);
  });

const receiveEmailQueue = ({
  batch,
  environment,
}: QueueInput): Effect.Effect<void, QueueDeliveryUnavailable> =>
  Effect.gen(function* () {
    if (batch.messages.some((message) => isEmailReplacementWork(message.body))) {
      if (environment.EMAIL_REPLACEMENT_WORKFLOW === undefined) {
        return yield* deliveryFailure(new Error("Email replacement unavailable"));
      }
      return yield* receiveWorkflowBatch(
        batch,
        receiveEmailReplacement({
          DB: environment.DB,
          EMAIL_REPLACEMENT_WORKFLOW: environment.EMAIL_REPLACEMENT_WORKFLOW,
        })
      ).pipe(Effect.withSpan("emailReplacement.receive"));
    }
    if (batch.messages.some((message) => isBrowserPairingEmailWork(message.body))) {
      if (environment.BROWSER_PAIRING_EMAIL_WORKFLOW === undefined) {
        return yield* deliveryFailure(new Error("Browser pairing email unavailable"));
      }
      return yield* receiveWorkflowBatch(
        batch,
        receiveBrowserPairingEmail({
          DB: environment.DB,
          BROWSER_PAIRING_EMAIL_WORKFLOW: environment.BROWSER_PAIRING_EMAIL_WORKFLOW,
        })
      );
    }
    return yield* deliveryFailure(new Error("Unknown email work"));
  }).pipe(Effect.mapError(deliveryFailure));

const receiveCanaryBatch = ({
  batch,
  environment,
}: QueueInput): Effect.Effect<void, QueueDeliveryUnavailable> =>
  Effect.gen(function* () {
    const message = batch.messages[0];
    const workflow = environment.OPERATIONAL_CANARY_WORKFLOW;
    if (batch.messages.length !== 1 || message === undefined || workflow === undefined) {
      return yield* deliveryFailure(new Error("Operational canary unavailable"));
    }
    const now = yield* Clock.currentTimeMillis;
    return yield* nativeDelivery(() =>
      receiveCanary({ DB: environment.DB, workflow, payload: message.body, now })
    );
  });

const receiveReservedSmoke = ({
  batch,
  environment,
}: QueueInput): Option.Option<Effect.Effect<void, QueueDeliveryUnavailable>> => {
  if (environment.SMOKE_QUEUE_NAME === undefined || batch.queue !== environment.SMOKE_QUEUE_NAME) {
    return Option.none();
  }
  return Option.some(
    smokeReady(environment)
      ? nativeDelivery(() => receiveSmoke({ batch, environment }))
      : Effect.fail(deliveryFailure(new Error("Smoke wiring unavailable")))
  );
};

const receiveBillingQueue = ({
  batch,
  environment,
}: QueueInput): Effect.Effect<void, QueueDeliveryUnavailable> =>
  Effect.gen(function* () {
    const refunds = batch.messages.filter((message) => isRefundWork(message.body));
    const charges = batch.messages.filter((message) => isBillingCollectionWork(message.body));
    if (refunds.length + charges.length !== batch.messages.length) {
      return yield* deliveryFailure("Invalid billing work");
    }
    if (refunds.length > 0) {
      if (environment.BILLING_REFUND_WORKFLOW === undefined) {
        return yield* deliveryFailure("Billing refunds unavailable");
      }
      yield* receiveRefunds({
        environment: { BILLING_REFUND_WORKFLOW: environment.BILLING_REFUND_WORKFLOW },
        batch: { messages: refunds },
      });
    }
    if (charges.length > 0) {
      if (environment.BILLING_COLLECTION_WORKFLOW === undefined) {
        return yield* deliveryFailure("Billing collection unavailable");
      }
      yield* receiveBillingCollection({
        environment: {
          DB: environment.DB,
          BILLING_COLLECTION_WORKFLOW: environment.BILLING_COLLECTION_WORKFLOW,
        },
        batch: { messages: charges },
      });
    }
  }).pipe(Effect.mapError(deliveryFailure));

const receiveIdentityOnlyQueue = ({
  batch,
  environment,
}: QueueInput): Option.Option<Effect.Effect<void, QueueDeliveryUnavailable>> => {
  if (batch.messages.some((message) => Schema.is(ProactivityDeliveryWork)(message.body))) {
    return Option.some(
      receiveProactivityWork({
        messages: batch.messages,
        workflow: Option.fromUndefinedOr(environment.WEEKLY_DELIVERY_WORKFLOW),
        coordinator: environment.USER_TRANSACTION_COORDINATOR,
      }).pipe(Effect.mapError(deliveryFailure))
    );
  }
  if (batch.messages.some((message) => Schema.is(WhatsAppWork)(message.body))) {
    return Option.some(
      nativeDelivery(() =>
        receiveWhatsAppWork({
          messages: batch.messages,
          coordinator: environment.USER_TRANSACTION_COORDINATOR,
        })
      )
    );
  }
  return Option.none();
};

const receiveWorkQueue = (input: QueueInput): Effect.Effect<void, QueueDeliveryUnavailable> => {
  const { batch, environment } = input;
  const smoke = receiveReservedSmoke(input);
  if (Option.isSome(smoke)) return smoke.value;
  const identityOnly = receiveIdentityOnlyQueue(input);
  if (Option.isSome(identityOnly)) return identityOnly.value;
  if (batch.messages.some((message) => isForwardedEmailWork(message.body))) {
    if (environment.EMAIL_BUCKET === undefined) {
      return Effect.fail(deliveryFailure(new Error("Email evidence unavailable")));
    }
    return Effect.tryPromise({
      try: () =>
        receiveForwardedEmailWork({
          messages: batch.messages,
          coordinator: environment.USER_TRANSACTION_COORDINATOR,
        }),
      catch: () => deliveryFailure(new ForwardedEmailDeliveryUnavailable()),
    }).pipe(Effect.withSpan("ingestion.forwarded-email.queue"));
  }
  if (batch.messages.some((message) => isStatementExtractionWork(message.body))) {
    const workflow = environment.STATEMENT_EXTRACTION_WORKFLOW;
    if (workflow === undefined) {
      return Effect.fail(deliveryFailure(new Error("Statement extraction unavailable")));
    }
    return receiveWorkflowBatch(batch, (entry) =>
      receiveStatementExtraction({
        environment: { DB: environment.DB, STATEMENT_EXTRACTION_WORKFLOW: workflow },
        messages: entry.messages,
      })
    ).pipe(Effect.mapError(deliveryFailure));
  }
  return batch.messages.some(
    (message) => isBillingCollectionWork(message.body) || isRefundWork(message.body)
  )
    ? receiveWorkflowBatch(batch, (entry) => receiveBillingQueue({ batch: entry, environment }))
    : receiveEmailQueue(input);
};

/** Preserve native Queue selection order inside the telemetry-owned Effect; payload validation and acknowledgment stay owner-held. */
export const dispatchCoreQueue = (
  input: QueueInput
): Effect.Effect<void, QueueDeliveryUnavailable> =>
  input.batch.queue === input.environment.OPERATIONAL_CANARY_QUEUE_NAME
    ? receiveCanaryBatch(input)
    : receiveWorkQueue(input);
