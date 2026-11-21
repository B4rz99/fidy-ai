import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { Clock, Layer, ManagedRuntime } from "effect";
import type { WorkerTelemetryEnvironment } from "./runtime/telemetry/contract";
import { completeCanary } from "./runtime/operational-health/operations";

import {
  cloudflareWorkerTelemetry,
  observeWorkerPromise,
  workerRelease,
} from "./runtime/telemetry/operations";

const canaryRuntime = ManagedRuntime.make(Layer.empty);

export class OperationalCanaryWorkflowV1 extends WorkflowEntrypoint<
  WorkerTelemetryEnvironment,
  unknown
> {
  run(event: WorkflowEvent<unknown>, step: WorkflowStep): Promise<void> {
    return observeWorkerPromise(
      () =>
        step.do("verify-operational-canary-v1", { retries: { limit: 0, delay: "1 second" } }, () =>
          completeCanary({
            payload: event.payload,
            now: canaryRuntime.runSync(Clock.currentTimeMillis),
          })
        ),
      {
        environment: workerRelease(this.env),
        telemetry: cloudflareWorkerTelemetry,
        operation: "workflow.operationalCanary",
      }
    );
  }
}
