import {
  dispatchRefunds as dispatchCorrections,
  dispatchVoidVerification as dispatchVerification,
  runRefundWorkflow as executeRefundWorkflow,
  receiveRefunds as receiveCorrections,
  isRefundWork as recognizesRefund,
} from "./internal/refund-workflow";
import { handlePaymentEnrollment as enroll } from "./internal/payment-enrollment";
import type { EnrollmentEnvironment } from "./contract";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers";
import { type Cause, Context, Effect, Layer, type Option, Schema } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";
import { makeAccessSigningKeysOutboundHttp } from "../../src/shell/outbound-http/operations";
import {
  type RefundDispatchInput,
  type RefundReceiveInput,
  type RefundSupportEnvironment,
  RefundWorkFailure,
  type RefundWorkflowExecution,
} from "./contract";
import { handleRefundSupport as supportRefund } from "./internal/refund-support";
import {
  type BillingCollectionEnvironment,
  type BillingCollectionFailure,
  type BillingQueuePublisher,
  type BillingRuntime,
  type BillingWorkflowStarter,
} from "./contract";
import {
  cloudflareWorkerTelemetry,
  observeProviderFetch,
  observeWorkerPromise,
  workerRelease,
} from "../runtime/telemetry/operations";
import { captureWorkflowFailure } from "../runtime/operational-health/operations";
import {
  receiveWompiBillingEvent as acceptEvent,
  dispatchBillingCollection as dispatch,
  receiveBillingCollection as receive,
  isBillingCollectionWork as recognizesWork,
  reconcileBillingCandidates as reconcile,
  runBillingCollectionWorkflow as runWorkflow,
} from "./internal/billing-workflow";
import { sweepExpiredEnrollmentAdmission as sweep } from "./internal/enrollment-admission";

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
        const clients = yield* Layer.build(FetchHttpClient.layer).pipe(
          Effect.provideService(
            FetchHttpClient.Fetch,
            observeProviderFetch(globalThis.fetch, {
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
    )
  );

/** Execute one versioned correction with a durable no-retry submission claim. */
export const runRefundWorkflow = (input: RefundWorkflowExecution): Promise<void> =>
  Effect.runPromise(
    Effect.tryPromise({ try: () => executeRefundWorkflow(input), catch: refundWorkFailure })
  );

export class BillingRefundWorkflowV1 extends WorkflowEntrypoint<BillingRuntime, unknown> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    return captureWorkflowFailure({
      db: this.env.DB,
      work: observeWorkerPromise(
        () =>
          runRefundWorkflow({
            environment: this.env,
            payload: event.payload,
            activity: (name, options, activity) => step.do(name, options, activity),
          }),
        {
          environment: workerRelease(this.env),
          telemetry: cloudflareWorkerTelemetry,
          operation: "workflow.billingRefund",
        }
      ),
    });
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
    environment: Readonly<{ DB: D1Database; BILLING_COLLECTION_WORKFLOW: BillingWorkflowStarter }>;
    batch: Readonly<{ messages: ReadonlyArray<{ body: unknown; ack: () => void }> }>;
  }>
): Effect.Effect<void, BillingCollectionFailure> => receive(input);
/** Retain only authentic Wompi event hints; settlement still requires verified provider lookup. */
export const receiveWompiBillingEvent = (
  input: Readonly<{
    request: Request;
    environment: BillingRuntime & Pick<BillingCollectionEnvironment, "WOMPI_EVENT_SECRET">;
  }>
): Effect.Effect<Response> => acceptEvent(input);
/** Start bounded reconciliation of retained unresolved billing identities. */
export const reconcileBillingCandidates = (
  input: Readonly<{ DB: D1Database; BILLING_COLLECTION_WORKFLOW: BillingWorkflowStarter }>
): Effect.Effect<void, BillingCollectionFailure> => reconcile(input);
/** Classify the bounded versioned billing Queue identity without granting billing authority. */
export const isBillingCollectionWork = (body: unknown): boolean => recognizesWork(body);
/** Retire expired admission counts without changing enrollment or billing evidence. */
export const sweepExpiredEnrollmentAdmission = (
  input: Readonly<{ db: D1Database; now: number }>
): Effect.Effect<void, Cause.UnknownError> => sweep(input);

export class BillingCollectionWorkflowV1 extends WorkflowEntrypoint<BillingRuntime, unknown> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    return captureWorkflowFailure({
      work: observeWorkerPromise(
        () =>
          runBillingCollectionWorkflow({
            environment: this.env,
            payload: event.payload,
            activity: (name, options, activity) => step.do(name, options, activity),
          }),
        {
          environment: workerRelease(this.env),
          telemetry: cloudflareWorkerTelemetry,
          operation: "workflow.billingCollection",
        }
      ),
      db: this.env.DB,
    });
  }
}

/** Execute one versioned billing Workflow through its bounded, no-retry activity seam. */
export const runBillingCollectionWorkflow = (
  input: Readonly<{
    environment: BillingRuntime;
    payload: unknown;
    activity: (
      name: string,
      options: WorkflowStepConfig,
      run: () => Promise<void>
    ) => Promise<void>;
  }>
): Promise<void> => runWorkflow(input);

/** Fresh-session browser enrollment; provider references and transient authorization stay private. */
export const handlePaymentEnrollment = (
  input: Readonly<{ request: Request; environment: EnrollmentEnvironment }>
): Promise<Response> => enroll(input);
