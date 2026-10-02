import { handleCardEnrollment as enroll } from "./internal/card-enrollment";
import type { EnrollmentEnvironment } from "./contract";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepConfig,
} from "cloudflare:workers";
import { type Cause, type Effect, type Option } from "effect";
import {
  type BillingCollectionEnvironment,
  type BillingCollectionFailure,
  type BillingQueuePublisher,
  type BillingRuntime,
  type BillingWorkflowStarter,
} from "./contract";
import {
  cloudflareWorkerTelemetry,
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
import { sweepExpiredCardPreparationAdmission as sweep } from "./internal/card-preparation-admission";

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
export const sweepExpiredCardPreparationAdmission = (
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

/** Fresh-session browser enrollment; provider references and transient card material remain private. */
export const handleCardEnrollment = (
  input: Readonly<{ request: Request; environment: EnrollmentEnvironment }>
): Promise<Response> => enroll(input);
