import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { completeCanary } from "./runtime/operational-canary";
import { captureWorkflowFailure } from "./runtime/operational-workflow-failure";
import {
  cloudflareWorkerTelemetry,
  observeWorkerPromise,
  workerRelease,
} from "./runtime/telemetry";

/** Private identity-free platform probe; a completed D1 step, not instance creation, proves execution. */
export class OperationalCanaryWorkflowV1 extends WorkflowEntrypoint<
  Readonly<{ DB: D1Database }>,
  unknown
> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    return captureWorkflowFailure(
      observeWorkerPromise(
        () =>
          step.do(
            "record-operational-canary-v1",
            { retries: { limit: 0, delay: "1 second" } },
            () => completeCanary(this.env.DB, event.payload, Date.now())
          ),
        {
          environment: workerRelease(this.env),
          telemetry: cloudflareWorkerTelemetry,
          operation: "workflow.operationalCanary",
        }
      ),
      this.env.DB
    );
  }
}
