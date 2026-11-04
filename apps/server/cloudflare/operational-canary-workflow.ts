import { runRecoveryJob } from "./recovery-lifecycle/operations";
import type { RecoveryLifecycleEnvironment } from "./recovery-lifecycle/contract";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { Clock, Effect } from "effect";

import type { WorkerTelemetryEnvironment } from "./runtime/telemetry/contract";
import { completeCanary } from "./runtime/operational-health/operations";

import {
  cloudflareWorkerTelemetry,
  observeWorkerPromise,
  workerRelease,
} from "./runtime/telemetry/operations";

/** Private identity-free platform probe; a completed native step, not instance creation, proves execution. */
export class OperationalCanaryWorkflowV1 extends WorkflowEntrypoint<
  WorkerTelemetryEnvironment & RecoveryLifecycleEnvironment,
  unknown
> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    return runRecoveryJob({
      environment: this.env,
      payload: event.payload,
      work: () =>
        observeWorkerPromise(
          () =>
            step.do(
              "verify-operational-canary-v1",
              { retries: { limit: 0, delay: "1 second" } },
              () =>
                completeCanary({
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
    });
  }
}
