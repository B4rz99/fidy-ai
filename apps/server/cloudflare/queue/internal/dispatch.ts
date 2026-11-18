import { SynchronizationWork } from "../../connections/contract";
import { WhatsAppLifecycleWork, WhatsAppWork } from "../../whatsapp/contract";
import { receiveWhatsAppWork, routeWhatsAppStatus } from "../../whatsapp/runtime";
import { LocalBillingCollection, WompiBillingEvent } from "../../subscription/contract";
import {
  isBillingCollectionWork,
  isRefundWork,
  offerNativeBillingWork,
  receiveBillingCollection,
  receiveRefunds,
} from "../../subscription/runtime";
import { workTraceParent } from "../../runtime/telemetry/operations";
import { Telemetry } from "../../../src/shell/observability/operations";
import {
  type SpanDescriptor,
  TelemetryAttempt,
  TelemetryRelease,
  boundedTelemetryCount,
} from "../../../src/shell/observability/contract";
import { ProactivityDeliveryWork } from "../../insights/contract";
import { receiveProactivityWork } from "../../insights/runtime";
import { Cause, Clock, Context, Data, Effect, Exit, Option, Schema } from "effect";
import type { CoreQueueEnvironment } from "../contract";
import {
  isEmailReplacementWork,
  receiveEmailReplacement,
  startLoginWorkflow,
} from "../../email-authentication/runtime";
import { NativeLoginEmailWork } from "../../email-authentication/contract";
import { receiveCanary } from "../../runtime/operational-health/operations";
import {
  isForwardedEmailWork,
  isStatementExtractionWork,
  receiveForwardedEmailWork,
  receiveStatementExtraction,
} from "../../ingestion/runtime";

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

const QueueRelease = Context.Reference<TelemetryRelease>(
  "@fidy/server/cloudflare/queue/QueueRelease",
  { defaultValue: () => "unknown" }
);

const queueAttemptDescriptor = (attempt: number, release: TelemetryRelease): SpanDescriptor => ({
  release,
  component: "api",
  operation: "worker.core.queue",
  trigger: "queue",
  spanOperation: "queue.process",
  workKind: "queue_attempt",
  metadata: {
    _tag: "Queue",
    attempt: TelemetryAttempt.make(Math.min(100, Math.max(1, Math.trunc(attempt)))),
    inputCount: boundedTelemetryCount(1),
    delayMilliseconds: Option.none(),
  },
});

const observeWorkflowMessage = <E>(
  batch: MessageBatch<unknown>,
  message: Message<unknown>,
  receive: (batch: MessageBatch<unknown>) => Effect.Effect<void, E>
): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    const telemetry = yield* Effect.serviceOption(Telemetry);
    const release = yield* QueueRelease;
    let retried = false;
    const observedMessage: Message<unknown> = {
      id: message.id,
      timestamp: message.timestamp,
      body: message.body,
      attempts: message.attempts,
      ack: () => message.ack(),
      retry: (options) => {
        retried = true;
        message.retry(options);
      },
    };
    const work = receive({
      queue: batch.queue,
      metadata: batch.metadata,
      messages: [observedMessage],
      ackAll: () => observedMessage.ack(),
      retryAll: (options) => observedMessage.retry(options),
    }).pipe(
      Effect.tap(() =>
        Option.match(telemetry, {
          onNone: () => Effect.void,
          onSome: (service) =>
            service.recordOutcome(
              retried
                ? {
                    outcome: "failed",
                    error: Option.some("operational_failure"),
                    retryable: true,
                  }
                : { outcome: "succeeded", error: Option.none(), retryable: false }
            ),
        })
      )
    );
    return yield* Option.match(telemetry, {
      onNone: () => work,
      onSome: (service) =>
        service.continueSpan(
          workTraceParent(message.body),
          queueAttemptDescriptor(message.attempts, release),
          work
        ),
    });
  });

// Handoff lookups may overlap; the Workflows and User coordinator retain execution authority.
const statementHandoffConcurrency = 8;

const receiveWorkflowBatch = <E>(
  batch: MessageBatch<unknown>,
  receive: (message: MessageBatch<unknown>) => Effect.Effect<void, E>,
  concurrency: 1 | 4 | typeof statementHandoffConcurrency = 1
): Effect.Effect<void, E> =>
  Effect.gen(function* () {
    const results = yield* Effect.forEach(
      batch.messages,
      (message) =>
        Effect.gen(function* () {
          const result = yield* Effect.exit(observeWorkflowMessage(batch, message, receive));
          if (Exit.isFailure(result) && Cause.hasInterrupts(result.cause)) {
            return yield* Effect.failCause(result.cause);
          }
          return result;
        }),
      { concurrency }
    );
    const failure = results.find(Exit.isFailure);
    if (failure !== undefined) return yield* Effect.failCause(failure.cause);
  });

const receiveEmailQueue = ({
  batch,
  environment,
}: QueueInput): Effect.Effect<void, QueueDeliveryUnavailable> =>
  Effect.gen(function* () {
    if (batch.messages.some((message) => Schema.is(NativeLoginEmailWork)(message.body))) {
      const workflow = environment.BROWSER_PAIRING_EMAIL_WORKFLOW;
      if (workflow === undefined) return yield* deliveryFailure("Login email unavailable");
      return yield* receiveWorkflowBatch(
        batch,
        (entry) =>
          Effect.gen(function* () {
            for (const message of entry.messages) {
              const work = yield* Schema.decodeUnknownEffect(NativeLoginEmailWork)(message.body);
              yield* startLoginWorkflow(workflow, work);
              message.ack();
            }
          }),
        4
      );
    }
    if (batch.messages.some((message) => isEmailReplacementWork(message.body))) {
      if (environment.EMAIL_REPLACEMENT_WORKFLOW === undefined) {
        return yield* deliveryFailure(new Error("Email replacement unavailable"));
      }
      return yield* receiveWorkflowBatch(
        batch,
        receiveEmailReplacement({
          DB: environment.DB,
          EMAIL_REPLACEMENT_WORKFLOW: environment.EMAIL_REPLACEMENT_WORKFLOW,
        }),
        4
      ).pipe(Effect.withSpan("emailReplacement.receive"));
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
    return yield* nativeDelivery(() => receiveCanary({ workflow, payload: message.body, now }));
  });

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
          ...(environment.USER_STORE === undefined ? {} : { USER_STORE: environment.USER_STORE }),
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

const receiveNativeEmailWork = (
  batch: QueueInput["batch"],
  environment: CoreQueueEnvironment
): Effect.Effect<void, QueueDeliveryUnavailable> => {
  const owner = environment.USER_STORE;
  if (environment.EMAIL_BUCKET === undefined || owner === undefined) {
    return Effect.fail(deliveryFailure(new Error("Email evidence unavailable")));
  }
  return Effect.tryPromise({
    try: () =>
      receiveForwardedEmailWork({
        messages: batch.messages,
        coordinator: owner,
      }),
    catch: () => deliveryFailure(new ForwardedEmailDeliveryUnavailable()),
  }).pipe(Effect.withSpan("ingestion.forwarded-email.queue"));
};
const receiveWorkQueue = (input: QueueInput): Effect.Effect<void, QueueDeliveryUnavailable> => {
  const { batch, environment } = input;
  const identityOnly = receiveIdentityOnlyQueue(input);
  if (Option.isSome(identityOnly)) return identityOnly.value;
  if (batch.messages.some((message) => isForwardedEmailWork(message.body))) {
    return receiveNativeEmailWork(batch, environment);
  }
  if (batch.messages.some((message) => isStatementExtractionWork(message.body))) {
    const workflow = environment.STATEMENT_EXTRACTION_WORKFLOW;
    const owner = environment.USER_STORE;
    if (workflow === undefined || owner === undefined) {
      return Effect.fail(deliveryFailure(new Error("Statement extraction unavailable")));
    }
    return receiveWorkflowBatch(
      batch,
      (entry) =>
        receiveStatementExtraction({
          environment: {
            USER_STORE: owner,
            STATEMENT_EXTRACTION_WORKFLOW: workflow,
          },
          messages: entry.messages,
        }),
      statementHandoffConcurrency
    ).pipe(Effect.mapError(deliveryFailure));
  }
  return batch.messages.some(
    (message) => isBillingCollectionWork(message.body) || isRefundWork(message.body)
  )
    ? receiveWorkflowBatch(batch, (entry) => receiveBillingQueue({ batch: entry, environment }))
    : receiveEmailQueue(input);
};

const CallbackWork = Schema.Union([
  WhatsAppLifecycleWork,
  WompiBillingEvent,
  LocalBillingCollection,
]);
const callbackWork = Schema.is(CallbackWork);
const deliverCallback = Effect.fn(function* (packet: unknown, environment: CoreQueueEnvironment) {
  const body = yield* Schema.decodeUnknownEffect(CallbackWork)(packet);
  if (Schema.is(WhatsAppLifecycleWork)(body)) {
    const { DIRECTORY, USER_STORE, USER_TRANSACTION_COORDINATOR } = environment;
    if (DIRECTORY === undefined || USER_STORE === undefined) {
      return yield* deliveryFailure("Callback routing unavailable");
    }
    return yield* routeWhatsAppStatus(body, {
      DIRECTORY,
      USER_STORE,
      USER_TRANSACTION_COORDINATOR,
    });
  }
  const workflow = environment.BILLING_COLLECTION_WORKFLOW;
  if (workflow === undefined) return yield* deliveryFailure("Billing workflow unavailable");
  yield* offerNativeBillingWork(workflow, body);
});
const receiveCallbackBatch = ({
  batch,
  environment,
}: QueueInput): Effect.Effect<void, QueueDeliveryUnavailable> =>
  receiveWorkflowBatch(batch, (entry) =>
    Effect.gen(function* () {
      const [message] = entry.messages;
      if (message === undefined) return;
      if (!callbackWork(message.body)) {
        return yield* receiveWorkQueue({ batch: entry, environment });
      }
      yield* deliverCallback(message.body, environment);
      message.ack();
    }).pipe(Effect.mapError(deliveryFailure))
  );
const selectQueue = (input: QueueInput): Effect.Effect<void, QueueDeliveryUnavailable> => {
  if (input.batch.queue === input.environment.CONNECTION_SYNCHRONIZATION_QUEUE_NAME) {
    return receiveWorkflowBatch(
      input.batch,
      (entry) =>
        Effect.gen(function* () {
          const [message] = entry.messages;
          if (message === undefined) return;
          const work = yield* Schema.decodeUnknownEffect(SynchronizationWork, {
            onExcessProperty: "error",
          })(message.body);
          const workflow = input.environment.CONNECTION_SYNCHRONIZATION_WORKFLOW;
          if (workflow === undefined) {
            return yield* deliveryFailure("Synchronization Workflow unavailable");
          }
          const started = yield* Effect.tryPromise(() =>
            workflow.create({ id: work.jobId, params: work })
          ).pipe(Effect.result);
          if (started._tag === "Failure") {
            const instance = yield* Effect.tryPromise(() => workflow.get(work.jobId));
            const status = (yield* Effect.tryPromise(() => instance.status())).status;
            if (status === "errored") yield* Effect.tryPromise(() => instance.restart());
            else if (
              !["queued", "running", "waiting", "waitingForPause", "paused", "complete"].includes(
                status
              )
            ) {
              return yield* deliveryFailure("Synchronization handoff unavailable");
            }
          }
          message.ack();
        }).pipe(Effect.mapError(deliveryFailure)),
      4
    );
  }
  if (input.batch.queue === input.environment.OPERATIONAL_CANARY_QUEUE_NAME) {
    return receiveCanaryBatch(input);
  }
  return input.batch.messages.some((message) => callbackWork(message.body))
    ? receiveCallbackBatch(input)
    : receiveWorkQueue(input);
};
/** Preserve native Queue selection order inside the telemetry-owned Effect; payload validation and acknowledgment stay owner-held. */
export const dispatchCoreQueue = (
  input: QueueInput
): Effect.Effect<void, QueueDeliveryUnavailable> =>
  selectQueue(input).pipe(
    Effect.provideService(
      QueueRelease,
      Option.getOrElse(
        Schema.decodeOption(TelemetryRelease)(input.environment.RELEASE_GIT_SHA),
        () => "unknown" as const
      )
    )
  );
