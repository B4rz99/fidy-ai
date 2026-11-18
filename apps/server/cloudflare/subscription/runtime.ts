import { Hex } from "effect/encoding";
import { digestBytes } from "../secret-material/operations";
import {
  type BillingCollectionFailure,
  type BillingObservationWorkflow,
  type BillingQueuePublisher,
  type BillingRuntime,
  type BillingWorkRouting,
  type BillingWorkflowActivity,
  type EnrollmentEnvironment,
  type LocalBillingCollection,
  LocalSourceCancellationWork,
  type PricingEnvironment,
  type RefundDispatchInput,
  type RefundReceiveInput,
  type RefundSupportEnvironment,
  RefundWorkFailure,
  type RefundWorkflowExecution,
  type SubscriptionCancellationDispatchInput,
  type SubscriptionRenewalDispatchInput,
  WompiBillingEvent,
  type WompiBindings,
  type WompiEventEnvironment,
  pricingName,
} from "./contract";
import { nativeBillingRequest } from "./internal/native-billing";
import {
  createStoreRuntime,
  openSqliteStore,
  storeReadiness,
  withStoreCapacity,
} from "../runtime/sqlite/operations";
import { type StoreReleaseEnvironment, storeReadinessUrl } from "../runtime/sqlite/contract";

import { pricingHistory } from "./pricing/operations";
import { pricingResponse, recoverPricing } from "./internal/pricing-object";
import { observeCancellation, pendingCancellation } from "./internal/local-cancellation";
import { RequestBodyPolicy } from "../http/contract";
import { boundedJsonBody } from "../http/operations";
import { publishPrice } from "./internal/publish-price";
import { withErasureRecovery } from "../erasure/runtime";
import { projections as erasureProjections } from "./internal/erasure";
import { makeErasureStore } from "../erasure-store/runtime";
import type { ErasureStore } from "../erasure-store/contract";
import { makeWompiTransport } from "./internal/wompi-runtime";
import { OutboundHttpLive } from "../outbound-http/runtime";
import { dispatchCancellations } from "./internal/source-cancellation";
import { dispatchSubscriptionRenewals as dispatchRenewals } from "./internal/subscription-renewal";
import {
  dispatchRefunds as dispatchCorrections,
  dispatchVoidVerification as dispatchVerification,
  runRefundWorkflow as executeRefundWorkflow,
  receiveRefunds as receiveCorrections,
  isRefundWork as recognizesRefund,
} from "./internal/refund-workflow";
import { handlePaymentEnrollment as enroll } from "./internal/payment-enrollment";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { type Cause, Clock, Context, Effect, Layer, Option, Result, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import {
  makeAccessSigningKeysOutboundHttp,
  type makeWompiOutboundHttp,
} from "../../src/shell/outbound-http/operations";
import { handleRefundSupport as supportRefund } from "./internal/refund-support";
import {
  captureObservedProviderFetch,
  cloudflareWorkerTelemetry,
  observeWorkerPromise,
  workTraceParent,
  workerRelease,
} from "../runtime/telemetry/operations";
import {
  receiveWompiBillingEvent as acceptEvent,
  dispatchBillingCollection as dispatch,
  receiveBillingCollection as receive,
  isBillingCollectionWork as recognizesWork,
  runBillingCollectionWorkflow as runWorkflow,
} from "./internal/billing-workflow";
import { reconcileBillingCandidates as reconcile } from "./internal/billing-observation";
import { sweepExpiredEnrollmentAdmission as sweep } from "./internal/enrollment-admission";

import {
  type BillingRecovery,
  billingWake as inspectBillingAlarm,
  answerRegistration as readRegistration,
  recoverLocalBilling,
} from "./internal/local-billing-work";
import { nativeEnrollment } from "./internal/native-enrollment";
import type { EnrollmentContext } from "./internal/enrollment-session";

export const offerLocalBilling = Effect.fn(function* (context: Omit<BillingRecovery, "transport">) {
  return yield* recoverLocalBilling({ ...context, transport: wompiOutboundHttp });
});
export const handleLocalEnrollment = Effect.fn(function* (
  request: Request,
  context: Omit<EnrollmentContext, "transport">,
  owns: (id: string) => boolean
) {
  return yield* nativeEnrollment({ ...context, transport: wompiOutboundHttp }, request, owns);
});
export const answerRegistration = Effect.fn(function* (
  request: Request,
  owns: (id: string) => boolean
) {
  return yield* readRegistration(request, owns);
});
export const billingWake = Effect.fn(function* (storage: DurableObjectStorage) {
  return yield* withStoreCapacity("required")(inspectBillingAlarm(storage));
});
/** Construct the native provider transport at the Subscription composition boundary. */
export const wompiOutboundHttp = (
  environment: WompiBindings
): Effect.Effect<ReturnType<typeof makeWompiOutboundHttp>> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fetcher = yield* captureObservedProviderFetch(globalThis.fetch, {
        provider: "wompi",
        environment,
        telemetry: cloudflareWorkerTelemetry,
      });
      const clients = yield* Layer.build(OutboundHttpLive).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetcher)
      );
      return makeWompiTransport({
        environment,
        httpClient: Context.get(clients, HttpClient.HttpClient),
      });
    })
  );

const refundWorkFailure = (error: unknown): RefundWorkFailure =>
  new RefundWorkFailure({
    reason: Schema.isSchemaError(error) ? "invalid-work" : "unavailable",
  });

/** Publish bounded versioned correction identities from their atomic acceptance outbox. */
export const dispatchRefunds = (
  input: RefundDispatchInput
): Effect.Effect<void, RefundWorkFailure> =>
  dispatchCorrections(input).pipe(Effect.mapError(refundWorkFailure));
/** Handoff keeps acknowledgment and duplicate execution behavior within the Subscription owner. */
export const receiveRefunds = (input: RefundReceiveInput): Effect.Effect<void, RefundWorkFailure> =>
  receiveCorrections(input).pipe(Effect.mapError(refundWorkFailure));
/** Classify correction work without interpreting payment/provider data as authority. */
export const isRefundWork = (body: unknown): boolean => recognizesRefund(body);

/** Reconcile only claimed card voids through bounded read-only transaction lookups. */
export const dispatchVoidVerification = (
  input: RefundDispatchInput
): Effect.Effect<void, RefundWorkFailure> =>
  dispatchVerification(input).pipe(Effect.mapError(refundWorkFailure));

/** Construct bounded signing-key transport for origin-verified billing support. */
export const handleRefundSupport = (
  input: Readonly<{ request: Request; environment: RefundSupportEnvironment }>
): Promise<Response> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clients = yield* Layer.build(OutboundHttpLive).pipe(
          Effect.provideService(
            FetchHttpClient.Fetch,
            yield* captureObservedProviderFetch(globalThis.fetch, {
              provider: "cloudflare-access",
              environment: workerRelease(input.environment),
              telemetry: cloudflareWorkerTelemetry,
            })
          )
        );
        const http = makeAccessSigningKeysOutboundHttp({
          issuer: input.environment.CLOUDFLARE_ACCESS_ISSUER,
          httpClient: Context.get(clients, HttpClient.HttpClient),
        });
        return yield* supportRefund({ ...input, http });
      })
    ),
    { signal: input.request.signal }
  );

/** Execute one versioned correction with a durable no-retry submission claim. */
export const runRefundWorkflow = (input: RefundWorkflowExecution): Promise<void> =>
  Effect.runPromise(
    Effect.tryPromise({
      try: () => executeRefundWorkflow({ ...input, wompiHttp: wompiOutboundHttp }),
      catch: refundWorkFailure,
    })
  );

export class BillingRefundWorkflowV1 extends WorkflowEntrypoint<BillingRuntime, unknown> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    return observeWorkerPromise(
      () =>
        runRefundWorkflow({
          environment: withErasureRecovery(this.env),
          payload: event.payload,
          activity: (name, options, activity) => step.do(name, options, activity),
        }),
      {
        environment: workerRelease(this.env),
        telemetry: cloudflareWorkerTelemetry,
        operation: "workflow.billingRefund",
        parent: workTraceParent(event.payload),
      }
    );
  }
}

/** Offer durable billing intent to the private Queue; missed offers remain recoverable. */
export const dispatchBillingCollection = (
  input: Readonly<
    { DB: D1Database; BILLING_COLLECTION_QUEUE: BillingQueuePublisher } & {
      identity: Option.Option<string>;
    }
  >
): Effect.Effect<void, BillingCollectionFailure> => dispatch(input);
/** Hand identity-only Queue work to its deterministic Workflow without repeating a charge. */
export const receiveBillingCollection = (
  input: Readonly<{
    environment: BillingWorkRouting &
      Readonly<{
        DB: D1Database;
        BILLING_COLLECTION_WORKFLOW: BillingObservationWorkflow;
      }>;
    batch: Readonly<{ messages: ReadonlyArray<{ body: unknown; ack: () => void }> }>;
  }>
): Effect.Effect<void, BillingCollectionFailure> => receive(input);
/** Retain only authentic Wompi event hints; settlement still requires verified provider lookup. */
export const receiveWompiBillingEvent = (
  input: Readonly<{
    request: Request;
    environment: WompiEventEnvironment;
  }>
): Effect.Effect<Response> => acceptEvent(input);
/** Start bounded reconciliation of retained unresolved billing identities. */
export const reconcileBillingCandidates = (
  input: Readonly<{ DB: D1Database; BILLING_COLLECTION_WORKFLOW: BillingObservationWorkflow }>
): Effect.Effect<void, BillingCollectionFailure> => reconcile(input);
/** Classify the bounded versioned billing Queue identity without granting billing authority. */
export const isBillingCollectionWork = (body: unknown): boolean => recognizesWork(body);
/** Retire expired admission counts without changing enrollment or billing evidence. */
export const sweepExpiredEnrollmentAdmission = (
  input: Readonly<{ db: D1Database; now: number }>
): Effect.Effect<void, Cause.UnknownError> => sweep(input);

export class BillingCollectionWorkflowV1 extends WorkflowEntrypoint<BillingRuntime, unknown> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    return observeWorkerPromise(
      () =>
        runBillingCollectionWorkflow({
          environment: withErasureRecovery(this.env),
          payload: event.payload,
          activity: (name, options, activity) => step.do(name, options, activity),
          sleep: (name, duration) => step.sleep(name, duration),
          observe: (name, options, activity) => step.do(name, options, activity),
        }),
      {
        environment: workerRelease(this.env),
        telemetry: cloudflareWorkerTelemetry,
        operation: "workflow.billingCollection",
        parent: workTraceParent(event.payload),
      }
    );
  }
}

/** Execute one versioned billing Workflow through its bounded, no-retry activity seam. */
export const runBillingCollectionWorkflow = (
  input: Readonly<{
    environment: BillingRuntime;
    payload: unknown;
    sleep: (name: string, duration: number) => Promise<void>;
  }> &
    (
      | Readonly<{ activity: BillingWorkflowActivity }>
      | Readonly<{ activity: BillingWorkflowActivity; observe: BillingWorkflowActivity<boolean> }>
    )
): Promise<void> =>
  runWorkflow({
    ...input,
    observe: "observe" in input ? Option.some(input.observe) : Option.none(),
    wompiHttp: wompiOutboundHttp,
  });

/** Fresh-session browser enrollment; provider references and transient authorization stay private. */
export const handlePaymentEnrollment = (
  input: Readonly<{ request: Request; environment: EnrollmentEnvironment }>
): Promise<Response> => enroll({ ...input, wompiHttp: wompiOutboundHttp });

/** Offer bounded due Subscription renewals to their original User coordinator; D1 owns eligibility and history. */
export const dispatchSubscriptionRenewals = (
  input: SubscriptionRenewalDispatchInput
): Effect.Effect<void, BillingCollectionFailure> => dispatchRenewals(input);

/** Recover retained DaviPlata cancellation intent through bounded identity-only offers. */
export const dispatchSubscriptionCancellations = (
  input: SubscriptionCancellationDispatchInput
): Effect.Effect<void, BillingCollectionFailure> => dispatchCancellations(input);

export const makeSubscriptionErasureStores = (db: D1Database): ReadonlyArray<ErasureStore> =>
  erasureProjections.map((projection) => makeErasureStore({ db, projection }));

/** Private pricing namespace, selected by a stable name. Only Core holds this binding. */
export class Pricing {
  private readonly version: string;
  private readonly state: DurableObjectState;
  private readonly users: Option.Option<DurableObjectNamespace>;
  private readonly runtime;
  constructor(
    state: DurableObjectState,
    env: StoreReleaseEnvironment & Partial<Readonly<{ USER_STORE: DurableObjectNamespace }>>
  ) {
    this.state = state;
    this.users = Option.fromUndefinedOr(env.USER_STORE);
    this.version = env.CF_VERSION_METADATA.id;
    this.runtime = createStoreRuntime({
      storage: state.storage,
      owner: "pricing",
      ceilingBytes: env.SQLITE_STORE_CAPACITY_BYTES,
    });
    if (state.id.name === pricingName) {
      state.waitUntil(
        state.blockConcurrencyWhile(() =>
          this.runtime.runPromise(openSqliteStore(pricingHistory, env.CF_VERSION_METADATA.id))
        )
      );
    }
  }

  alarm(): Promise<void> {
    return Option.match(this.users, {
      onNone: () => Promise.resolve(),
      onSome: (users) =>
        this.runtime.runPromise(recoverPricing(this.state.storage, users)).then(() => undefined),
    });
  }
  fetch(request: Request): Promise<Response> {
    if (this.state.id.name !== pricingName) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
    if (request.method === "GET" && request.url === storeReadinessUrl) {
      return this.runtime.runPromise(
        storeReadiness({ history: pricingHistory, release: this.version })
      );
    }
    return this.runtime.runPromise(
      pricingResponse(request, this.state.storage, Option.isSome(this.users)).pipe(
        Effect.catchCause(() => Effect.succeed(new Response(null, { status: 503 })))
      )
    );
  }
}

/** Construct the bounded Access signing-key transport for private Price publication. */
export const handlePricePublication = (
  input: Readonly<{ request: Request; environment: PricingEnvironment }>
): Effect.Effect<Response, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = makeAccessSigningKeysOutboundHttp({
      issuer: input.environment.CLOUDFLARE_ACCESS_ISSUER,
      httpClient: yield* HttpClient.HttpClient,
    });
    return yield* publishPrice({ ...input, http });
  });

const workPendingStatus = 202;
const workAbsentStatus = 204;
const cancellationBody = Schema.decodeSync(RequestBodyPolicy)({
  maximumBytes: 1024,
  deadlineMilliseconds: 5000,
});
/** Only the private User owner receives these calls. The destination checks the object and retained work identity. */
export const handleSourceCancellationWork = Effect.fnUntraced(function* (
  input: Readonly<{
    request: Request;
    owns: (id: string) => boolean;
    environment: WompiBindings;
  }>
) {
  const action = new URL(input.request.url).pathname;
  const body = yield* boundedJsonBody({
    request: input.request,
    policy: cancellationBody,
    schema: LocalSourceCancellationWork,
  });
  if (Option.isNone(body) || !input.owns(body.value.userId)) {
    return new Response(null, { status: 404 });
  }
  if (action === "/work/source-cancellation/observe") {
    yield* observeCancellation({
      work: body.value,
      current: yield* Clock.currentTimeMillis,
      environment: input.environment.WOMPI_ENVIRONMENT,
      http: yield* wompiOutboundHttp(input.environment),
    });
  }
  const pending = yield* pendingCancellation(body.value);
  return new Response(null, { status: pending ? workPendingStatus : workAbsentStatus });
});

export const handleNativeBillingCallback = Effect.fn(function* (
  input: Omit<Parameters<typeof nativeBillingRequest>[0], "transport">
) {
  return yield* nativeBillingRequest({ ...input, transport: wompiOutboundHttp });
});
const callbackWorkflowId = Effect.fn(function* (event: typeof WompiBillingEvent.Type) {
  const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(WompiBillingEvent))(event);
  return "wompi-event-" + Hex.encode(yield* digestBytes(new TextEncoder().encode(encoded)));
});

const acceptedWorkflowStates: ReadonlySet<InstanceStatus["status"]> = new Set([
  "queued",
  "running",
  "waiting",
  "complete",
]);

export const offerNativeBillingWork = Effect.fn(function* (
  workflow: BillingObservationWorkflow,
  work: typeof LocalBillingCollection.Type | typeof WompiBillingEvent.Type
) {
  const id =
    work._tag === "WompiBillingEvent"
      ? yield* callbackWorkflowId(work)
      : "collect-" + work.userId + "-" + work.attemptId;
  const started = yield* Effect.result(
    Effect.tryPromise(() =>
      workflow.create({
        id,
        params: work,
        retention: { successRetention: "3 days", errorRetention: "3 days" },
      })
    )
  );
  if (Result.isSuccess(started)) return;
  const instance = yield* Effect.tryPromise(() => workflow.get(id));
  const { status } = yield* Effect.tryPromise(() => instance.status());
  if (acceptedWorkflowStates.has(status)) return;
  if (status === "errored") return yield* Effect.tryPromise(() => instance.restart());
  return yield* Effect.fail("billing-workflow-unavailable" as const);
});
