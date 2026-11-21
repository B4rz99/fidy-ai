import { backgroundWorkAllowed } from "../release-isolation/operations";
import type { AcceptanceWindowBindings } from "../release-isolation/contract";
import {
  offerRefunds,
  refundWake,
  runOwnerRefund,
  runRefundStep,
} from "./internal/native-refund-work";
import { handleLocalRefund } from "./internal/native-refund";
import { ownerCheckRequest } from "../maintenance/contract";
import {
  fenceErasureParticipant,
  handleSharedCleanup,
  participantDrain,
} from "../erasure-store/operations";
import {
  participantCleanupUrl,
  participantDrainedUrl,
  participantFenceUrl,
} from "../erasure-store/contract";
import { Hex } from "effect/encoding";
import { digestBytes } from "../secret-material/operations";
import {
  type BillingObservationWorkflow,
  type BillingWorkRouting,
  type BillingWorkflowActivity,
  type BillingWorkflowEnvironment,
  type LocalBillingCollection,
  LocalRefundWork,
  LocalSourceCancellationWork,
  type PricingEnvironment,
  type RefundReceiveInput,
  type RefundSupportEnvironment,
  RefundWorkFailure,
  WompiBillingEvent,
  type WompiBindings,
  type WompiEventEnvironment,
  pricingName,
} from "./contract";
import { nativeBillingRequest } from "./internal/native-billing";
import {
  createStoreRuntime,
  observeStoreCheck,
  openSqliteStore,
  storeReadiness,
  withStoreCapacity,
} from "../runtime/sqlite/operations";
import { type StoreReleaseEnvironment, storeReadinessUrl } from "../runtime/sqlite/contract";

import { pricingHistory } from "./pricing/operations";
import {
  cleanPricingCase,
  outstandingPricingRegistrations,
  pricingResponse,
  recoverPricing,
} from "./internal/pricing-object";
import { observeCancellation, pendingCancellation } from "./internal/local-cancellation";
import { RequestBodyPolicy } from "../http/contract";
import { boundedJsonBody } from "../http/operations";
import { publishPrice } from "./internal/publish-price";
import { wompiTransport } from "./internal/wompi-runtime";
import { OutboundHttpLive, installedProviderFetch } from "../outbound-http/runtime";
import {
  receiveRefunds as receiveCorrections,
  isRefundWork as recognizesRefund,
} from "./internal/refund-workflow";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import {
  Cause,
  Clock,
  Context,
  Effect,
  Layer,
  ManagedRuntime,
  Match,
  Option,
  Result,
  Schema,
} from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { OutboundHttp, type OutboundHttpService } from "../../src/shell/outbound-http/operations";
import { handleRefundSupport as supportRefund } from "./internal/refund-support";
import {
  cloudflareWorkerTelemetry,
  observeWorkerPromise,
  workTraceParent,
  workerRelease,
} from "../runtime/telemetry/operations";
import {
  receiveWompiBillingEvent as acceptEvent,
  isBillingCollectionWork as recognizesWork,
  runBillingCollectionWorkflow as runWorkflow,
} from "./internal/billing-workflow";
import { receiveLocalSourceCancellation } from "./internal/billing-observation";

import {
  type BillingRecovery,
  billingWake as inspectBillingAlarm,
  answerRegistration as readRegistration,
  recoverLocalBilling,
} from "./internal/local-billing-work";
import { nativeEnrollment } from "./internal/native-enrollment";
import type { EnrollmentContext } from "./internal/enrollment-session";

const boundaryRuntime = ManagedRuntime.make(Layer.empty);

export const offerLocalBilling = Effect.fn(function* (context: Omit<BillingRecovery, "transport">) {
  return yield* recoverLocalBilling({
    ...context,
    transport: wompiOutboundHttp,
  });
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

export const wompiOutboundHttp = (environment: WompiBindings): Effect.Effect<OutboundHttpService> =>
  Effect.scoped(
    Effect.gen(function* () {
      const fetcher = yield* installedProviderFetch({
        provider: "wompi",
        environment,
        telemetry: cloudflareWorkerTelemetry,
      });

      const clients = yield* Layer.build(OutboundHttpLive).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetcher)
      );

      return wompiTransport({
        environment,
        httpClient: Context.get(clients, HttpClient.HttpClient),
      });
    })
  );

const refundWorkFailure = (error: unknown): RefundWorkFailure =>
  new RefundWorkFailure({
    reason: Schema.isSchemaError(error) ? "invalid-work" : "unavailable",
  });

export const receiveRefunds = (input: RefundReceiveInput): Effect.Effect<void, RefundWorkFailure> =>
  receiveCorrections(input).pipe(Effect.mapError(refundWorkFailure));

export const isRefundWork = (body: unknown): boolean => recognizesRefund(body);

export const handleRefundSupport = (
  input: Readonly<{ request: Request; environment: RefundSupportEnvironment }>
): Promise<Response> =>
  boundaryRuntime.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const clients = yield* Layer.build(OutboundHttpLive).pipe(
          Effect.provideService(
            FetchHttpClient.Fetch,
            yield* installedProviderFetch({
              provider: "cloudflare-access",
              environment: workerRelease(input.environment),
              telemetry: cloudflareWorkerTelemetry,
            })
          )
        );

        const http = OutboundHttp.accessSigningKeys({
          issuer: input.environment.CLOUDFLARE_ACCESS_ISSUER,
          httpClient: Context.get(clients, HttpClient.HttpClient),
        });

        return yield* supportRefund({ ...input, http });
      })
    ),
    { signal: input.request.signal }
  );

export class BillingRefundWorkflowV1 extends WorkflowEntrypoint<
  {
    USER_STORE: DurableObjectNamespace;
    RELEASE_GIT_SHA: string;
    RECOVERY_ISOLATION: string;
  } & AcceptanceWindowBindings,
  unknown
> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    return boundaryRuntime.runPromise(backgroundWorkAllowed(this.env)).then((allowed) => {
      if (!allowed) throw Error("Billing execution is closed");

      return this.execute(event, step);
    });
  }
  private execute(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    return observeWorkerPromise(
      () =>
        step.do(
          "submit-or-verify-correction-v1",
          {
            retries: { limit: 0, delay: "1 second", backoff: "constant" },
            timeout: "30 seconds",
          },
          () => boundaryRuntime.runPromise(runRefundStep(event.payload, this.env.USER_STORE))
        ),
      {
        environment: workerRelease(this.env),
        telemetry: cloudflareWorkerTelemetry,
        operation: "workflow.billingRefund",
        parent: workTraceParent(event.payload),
      }
    );
  }
}

export const receiveWompiBillingEvent = (
  input: Readonly<{
    request: Request;
    environment: WompiEventEnvironment;
  }>
): Effect.Effect<Response> => acceptEvent(input);

export const isBillingCollectionWork = (body: unknown): boolean => recognizesWork(body);

export class BillingCollectionWorkflowV1 extends WorkflowEntrypoint<
  BillingWorkflowEnvironment & AcceptanceWindowBindings,
  unknown
> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    return boundaryRuntime.runPromise(backgroundWorkAllowed(this.env)).then((allowed) => {
      if (!allowed) throw Error("Billing execution is closed");

      return this.execute(event, step);
    });
  }
  private execute(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    return observeWorkerPromise(
      () =>
        runBillingCollectionWorkflow({
          environment: this.env,
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

export const runBillingCollectionWorkflow = (
  input: Readonly<{
    environment: BillingWorkflowEnvironment;
    payload: unknown;
    sleep: (name: string, duration: number) => Promise<void>;
  }> &
    (
      | Readonly<{ activity: BillingWorkflowActivity }>
      | Readonly<{
          activity: BillingWorkflowActivity;
          observe: BillingWorkflowActivity<boolean>;
        }>
    )
): Promise<void> =>
  runWorkflow({
    ...input,
    observe: "observe" in input ? Option.some(input.observe) : Option.none(),
    wompiHttp: wompiOutboundHttp,
  });

export class Pricing {
  private readonly version: string;
  private readonly state: DurableObjectState;
  private readonly window: AcceptanceWindowBindings;
  private readonly erasure: Option.Option<DurableObjectNamespace>;
  private readonly users: Option.Option<DurableObjectNamespace>;
  private readonly runtime;
  constructor(
    state: DurableObjectState,
    env: StoreReleaseEnvironment &
      AcceptanceWindowBindings &
      Partial<
        Readonly<{
          USER_STORE: DurableObjectNamespace;
          ERASURE: DurableObjectNamespace;
        }>
      >
  ) {
    this.state = state;
    this.window = env;
    this.erasure = Option.fromUndefinedOr(env.ERASURE);
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
    return boundaryRuntime.runPromise(backgroundWorkAllowed(this.window)).then((allowed) =>
      allowed
        ? Option.match(this.users, {
            onNone: () => Promise.resolve(),
            onSome: (users) =>
              this.runtime
                .runPromise(recoverPricing(this.state.storage, users))
                .then(() => undefined),
          })
        : undefined
    );
  }
  private erasureCommand(request: Request): Promise<Response> {
    if (request.url === participantCleanupUrl && Option.isSome(this.erasure)) {
      return this.runtime.runPromise(
        handleSharedCleanup(request, this.erasure.value, cleanPricingCase).pipe(
          Effect.catchCause(() => Effect.succeed(new Response(null, { status: 503 })))
        )
      );
    }

    if (request.url === participantDrainedUrl) {
      return this.runtime.runPromise(
        participantDrain(request, outstandingPricingRegistrations).pipe(
          Effect.catchCause(() => Effect.succeed(new Response(null, { status: 503 })))
        )
      );
    }

    if (request.url === participantFenceUrl && Option.isSome(this.users)) {
      return this.runtime.runPromise(
        fenceErasureParticipant(request, this.users.value, this.state.storage).pipe(
          Effect.catchCause(() => Effect.succeed(new Response(null, { status: 503 })))
        )
      );
    }

    return Promise.resolve(new Response(null, { status: 503 }));
  }
  fetch(request: Request): Promise<Response> {
    if (this.state.id.name !== pricingName) {
      return Promise.resolve(new Response(null, { status: 404 }));
    }

    if (
      request.method === "POST" &&
      [participantCleanupUrl, participantDrainedUrl, participantFenceUrl].includes(request.url)
    ) {
      return this.erasureCommand(request);
    }

    if (request.method === "GET" && request.url === storeReadinessUrl) {
      return this.runtime.runPromise(
        storeReadiness({ history: pricingHistory, release: this.version })
      );
    }

    const work = pricingResponse(request, this.state.storage, Option.isSome(this.users));

    return this.runtime.runPromise(
      (ownerCheckRequest(request)
        ? work.pipe(
            observeStoreCheck({
              storage: this.state.storage,
              history: pricingHistory,
              release: this.version,
            })
          )
        : work
      ).pipe(Effect.catchCause(() => Effect.succeed(new Response(null, { status: 503 }))))
    );
  }
}

export const handlePricePublication = (
  input: Readonly<{ request: Request; environment: PricingEnvironment }>
): Effect.Effect<Response, never, HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = OutboundHttp.accessSigningKeys({
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

  return new Response(null, {
    status: pending ? workPendingStatus : workAbsentStatus,
  });
});

export const handleNativeBillingCallback = Effect.fn(function* (
  input: Omit<Parameters<typeof nativeBillingRequest>[0], "transport">
) {
  return yield* nativeBillingRequest({
    ...input,
    transport: wompiOutboundHttp,
  });
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

const workflowId = Effect.fnUntraced(function* (
  work:
    | typeof LocalBillingCollection.Type
    | typeof LocalRefundWork.Type
    | typeof WompiBillingEvent.Type
) {
  return yield* Match.value(work).pipe(
    Match.tagsExhaustive({
      WompiBillingEvent: (work) => callbackWorkflowId(work),
      RunUserRefund: (work) =>
        Effect.succeed(
          "refund-" + work.userId + "-" + work.refundAttemptId + "-" + work.verification
        ),
      CollectUserBillingAttempt: (work) =>
        Effect.succeed("collect-" + work.userId + "-" + work.attemptId),
    })
  );
});

export const offerNativeBillingWork = Effect.fn(function* (
  workflow: BillingObservationWorkflow,
  work:
    | typeof LocalBillingCollection.Type
    | typeof WompiBillingEvent.Type
    | typeof LocalRefundWork.Type
) {
  const id = yield* workflowId(work);

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

export const handleNativeRefund: typeof handleLocalRefund = (...args) => handleLocalRefund(...args);

export const recoverNativeRefunds = Effect.fnUntraced(function* (
  input: Parameters<typeof offerRefunds>[0]
) {
  return yield* offerRefunds(input).pipe(Effect.mapError((cause) => new Cause.UnknownError(cause)));
});

export const repairRefundAlarm = Effect.fnUntraced(function* (storage: DurableObjectStorage) {
  return yield* refundWake(storage).pipe(withStoreCapacity("required"));
});

export const handleNativeRefundWork = Effect.fnUntraced(function* (
  request: Request,
  context: Omit<Parameters<typeof runOwnerRefund>[1], "transport">
) {
  const work = yield* Effect.tryPromise(() => request.json()).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(LocalRefundWork))
  );

  yield* runOwnerRefund(work, { ...context, transport: wompiOutboundHttp });

  return new Response(null, { status: 204 });
});

export const receiveBillingHandoff = Effect.fn(function* ({
  environment,
  workflow,
  body,
}: {
  environment: BillingWorkRouting;
  workflow: BillingObservationWorkflow;
  body: typeof LocalSourceCancellationWork.Type | Parameters<typeof offerNativeBillingWork>[1];
}) {
  return yield* Schema.is(LocalSourceCancellationWork)(body)
    ? receiveLocalSourceCancellation({ environment, workflow, work: body })
    : offerNativeBillingWork(workflow, body);
});
