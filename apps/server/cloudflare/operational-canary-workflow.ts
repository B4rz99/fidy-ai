import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Clock, Effect } from "effect";

import { captureWorkflowFailure, completeCanary } from "./runtime/operational-health/operations";

import {
  cloudflareWorkerTelemetry,
  observeWorkerPromise,
  workerRelease,
} from "./runtime/telemetry/operations";

/** Private identity-free platform probe; a completed D1 step, not instance creation, proves execution. */
export class OperationalCanaryWorkflowV1 extends WorkflowEntrypoint<
  Readonly<{ DB: D1Database }>,
  unknown
> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    return captureWorkflowFailure({
      work: observeWorkerPromise(
        () =>
          step.do(
            "record-operational-canary-v1",
            { retries: { limit: 0, delay: "1 second" } },
            () =>
              completeCanary({
                db: this.env.DB,
                payload: event.payload,
                now: Effect.runSync(Clock.currentTimeMillis),
              })
          ),
        {
          environment: workerRelease(this.env),
          telemetry: cloudflareWorkerTelemetry,
          operation: "workflow.operationalCanary",
        }
      ),
      db: this.env.DB,
    });
  }
}
