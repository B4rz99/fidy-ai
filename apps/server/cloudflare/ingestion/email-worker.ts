import { runRecoveryOperation } from "../recovery-lifecycle/operations";
import {
  makeRecoveryPublisher,
  withRecoveryNativeEnvironment,
} from "../recovery-lifecycle/runtime";
import type { RecoveryLifecycleEnvironment } from "../recovery-lifecycle/contract";
import type { AuthoritativeStoreEnvironment } from "../sqlite-store/contract";
import { withAuthoritativeStore } from "../sqlite-store/operations";
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

type EmailBindings = Omit<ForwardedEmailEnvironment, "DB"> &
  AuthoritativeStoreEnvironment &
  RecoveryLifecycleEnvironment;

const selected = (environment: EmailBindings): ForwardedEmailEnvironment =>
  withRecoveryNativeEnvironment(
    withAuthoritativeStore({
      ...environment,
      EMAIL_QUEUE: makeRecoveryPublisher({ binding: environment.EMAIL_QUEUE, environment }),
    })
  );

type EmailWorker = Readonly<{
  email: (message: ForwardedEmailMessage, environment: EmailBindings) => Promise<void>;
  scheduled: (
    controller: Pick<ScheduledController, "scheduledTime">,
    environment: EmailBindings
  ) => Promise<void>;
}>;

/** Compose the native Email entrypoints with narrow Ingestion and Maintenance authorities. */
export const makeEmailWorker = (telemetry: TelemetryService): EmailWorker => ({
  email: (message, environment) =>
    runRecoveryOperation({
      environment,
      work: () =>
        receiveForwardedEmail({
          message,
          environment: withErasureRecovery(selected(environment)),
        }).pipe(
          observeWorkerExecution({
            telemetry,
            environment: workerRelease(environment),
            operation: "worker.email.receive",
          }),
          Effect.runPromise
        ),
    }),
  scheduled: (controller, environment) =>
    runRecoveryOperation({
      environment,
      work: () =>
        runEmailMaintenance({
          environment: withErasureRecovery(selected(environment)),
          scheduledAtEpochMs: controller.scheduledTime,
        }).pipe(
          observeWorkerExecution({
            telemetry,
            environment: workerRelease(environment),
            operation: "worker.email.scheduled",
          }),
          Effect.runPromise
        ),
    }),
});

export default makeEmailWorker(cloudflareWorkerTelemetry);
