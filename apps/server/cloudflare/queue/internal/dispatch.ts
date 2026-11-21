import { SynchronizationWork } from "../../connections/contract";
import { WhatsAppLifecycleWork } from "../../whatsapp/contract";
import { routeWhatsAppStatus } from "../../whatsapp/runtime";
import {
  LocalBillingCollection,
  LocalRefundWork,
  LocalSourceCancellationWork,
  WompiBillingEvent,
} from "../../subscription/contract";
import { receiveBillingHandoff } from "../../subscription/runtime";
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
import { Cause, Clock, Context, Data, Effect, Exit, Option, Result, Schema } from "effect";
import type { CoreQueueEnvironment } from "../contract";
import { startLoginWorkflow } from "../../email-authentication/runtime";
import { NativeLoginEmailWork } from "../../email-authentication/contract";
import { receiveCanary } from "../../runtime/operational-health/operations";
import {
  isForwardedEmailWork,
  isStatementExtractionWork,
  receiveForwardedEmailWork,
  receiveNativeStatementExtraction,
} from "../../ingestion/runtime";

export class QueueDeliveryUnavailable extends Data.TaggedError("QueueDeliveryUnavailable")<{
  readonly original: unknown;
}> {}

class ForwardedEmailDeliveryUnavailable extends Data.TaggedError(
  "ForwardedEmailDeliveryUnavailable"
) {}

const isQueueDeliveryUnavailable = Schema.is(Schema.instanceOf(QueueDeliveryUnavailable));

const deliveryFailure = (original: unknown): QueueDeliveryUnavailable =>
  isQueueDeliveryUnavailable(original) ? original : new QueueDeliveryUnavailable({ original });

type QueueInput = Readonly<{ batch: MessageBatch<unknown>; environment: CoreQueueEnvironment }>;

const nativeDelivery = (work: () => Promise<void>): Effect.Effect<void, QueueDeliveryUnavailable> =>
  Effect.tryPromise({ try: work, catch: deliveryFailure });

const startLoginMessage = Effect.fnUntraced(function* (
  workflow: Parameters<typeof startLoginWorkflow>[0],
  message: Message<unknown>
) {
  const work = yield* Schema.decodeUnknownEffect(NativeLoginEmailWork)(message.body);
  yield* startLoginWorkflow(workflow, work);
  message.ack();
});

const SpanMetadata = Data.taggedEnum<SpanDescriptor["metadata"]>();

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
  metadata: SpanMetadata.Queue({
    attempt: TelemetryAttempt.make(Math.min(100, Math.max(1, Math.trunc(attempt)))),
    inputCount: boundedTelemetryCount(1),
    delayMilliseconds: Option.none(),
  }),
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
          Effect.forEach(entry.messages, (message) => startLoginMessage(workflow, message), {
            discard: true,
          }),
        4
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

    return yield* nativeDelivery(() => receiveCanary({ workflow, payload: message.body, now }));
  });

const receiveIdentityOnlyQueue = ({
  batch,
  environment,
}: QueueInput): Option.Option<Effect.Effect<void, QueueDeliveryUnavailable>> => {
  if (batch.messages.some((message) => Schema.is(ProactivityDeliveryWork)(message.body))) {
    return Option.some(
      receiveProactivityWork({
        messages: batch.messages,
        workflow: Option.fromUndefinedOr(environment.WEEKLY_DELIVERY_WORKFLOW),
        users: Option.fromUndefinedOr(environment.USER_STORE),
      }).pipe(Effect.mapError(deliveryFailure))
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
        receiveNativeStatementExtraction({
          environment: {
            USER_STORE: owner,
            STATEMENT_EXTRACTION_WORKFLOW: workflow,
          },
          messages: entry.messages,
        }),
      statementHandoffConcurrency
    ).pipe(Effect.mapError(deliveryFailure));
  }

  return receiveEmailQueue(input);
};

const CallbackWork = Schema.Union([
  LocalRefundWork,
  LocalSourceCancellationWork,
  WhatsAppLifecycleWork,
  WompiBillingEvent,
  LocalBillingCollection,
]);

const callbackWork = Schema.is(CallbackWork);

const deliverCallback = Effect.fn(function* (packet: unknown, environment: CoreQueueEnvironment) {
  const body = yield* Schema.decodeUnknownEffect(CallbackWork)(packet);

  if (Schema.is(WhatsAppLifecycleWork)(body)) {
    const { DIRECTORY, USER_STORE } = environment;

    if (DIRECTORY === undefined || USER_STORE === undefined) {
      return yield* deliveryFailure("Callback routing unavailable");
    }

    return yield* routeWhatsAppStatus(body, {
      DIRECTORY,
      USER_STORE,
    });
  }

  const workflow = Schema.is(LocalRefundWork)(body)
    ? environment.BILLING_REFUND_WORKFLOW
    : environment.BILLING_COLLECTION_WORKFLOW;

  if (workflow === undefined) return yield* deliveryFailure("Billing workflow unavailable");
  yield* receiveBillingHandoff({ environment, workflow, body });
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

          if (Result.isFailure(started)) {
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
