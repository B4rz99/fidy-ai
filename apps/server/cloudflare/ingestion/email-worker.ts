import { withErasureRecovery } from "../erasure/runtime";
import { Effect } from "effect";
import type { TelemetryService } from "../../src/shell/observability/contract";
import type { ForwardedEmailEnvironment, ForwardedEmailMessage } from "./contract";
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

/** Refuse native delivery until institution verification and Connection admission exist;
 * maintenance still recovers retained work under its original admission and deadlines.
 */
export const makeEmailWorker = (telemetry: TelemetryService): EmailWorker => ({
  email: (message, environment) =>
    Effect.sync(() => message.setReject("Mailbox unavailable")).pipe(
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
