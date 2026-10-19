import { withErasureRecovery } from "../erasure/runtime";
import { Effect } from "effect";
import type { TelemetryService } from "../../src/shell/observability/contract";
import type { ForwardedEmailEnvironment, ForwardedEmailMessage } from "./contract";
import { receiveForwardedEmail } from "./runtime";
import { runEmailMaintenance } from "../maintenance/runtime";
import {
  cloudflareWorkerTelemetry,
  observeWorkerExecution,
  workerRelease,
} from "../runtime/telemetry/operations";

type EmailWorker = Readonly<{
  email: (message: ForwardedEmailMessage, environment: ForwardedEmailEnvironment) => Promise<void>;
  scheduled: (
    controller: Pick<ScheduledController, "scheduledTime">,
    environment: ForwardedEmailEnvironment
  ) => Promise<void>;
}>;

/** Compose the native Email entrypoints with narrow Ingestion and Maintenance authorities. */
export const makeEmailWorker = (telemetry: TelemetryService): EmailWorker => ({
  email: (message, environment) =>
    receiveForwardedEmail({ message, environment: withErasureRecovery(environment) }).pipe(
      observeWorkerExecution({
        telemetry,
        environment: workerRelease(environment),
        operation: "worker.email.receive",
      }),
      Effect.runPromise
    ),
  scheduled: (controller, environment) =>
    runEmailMaintenance({
      environment: withErasureRecovery(environment),
      scheduledAtEpochMs: controller.scheduledTime,
    }).pipe(
      observeWorkerExecution({
        telemetry,
        environment: workerRelease(environment),
        operation: "worker.email.scheduled",
      }),
      Effect.runPromise
    ),
});

export default makeEmailWorker(cloudflareWorkerTelemetry);
