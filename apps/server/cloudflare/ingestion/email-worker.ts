import { Effect } from "effect";
import type { TelemetryService } from "@fidy/server/telemetry";
import type { ForwardedEmailEnvironment, ForwardedEmailMessage } from "./contract";
import { receiveForwardedEmail } from "./runtime";
import { runEmailMaintenance } from "../maintenance/runtime";
import {
  cloudflareWorkerTelemetry,
  observeWorkerExecution,
  workerRelease,
} from "../runtime/telemetry";

type EmailWorker = Readonly<{
  email: (message: ForwardedEmailMessage, environment: ForwardedEmailEnvironment) => Promise<void>;
  scheduled: (controller: unknown, environment: ForwardedEmailEnvironment) => Promise<void>;
}>;

/** Compose the native Email entrypoints with narrow Ingestion and Maintenance authorities. */
export const makeEmailWorker = (telemetry: TelemetryService): EmailWorker => ({
  email: (message, environment) =>
    receiveForwardedEmail({ message, environment }).pipe(
      observeWorkerExecution({
        telemetry,
        environment: workerRelease(environment),
        operation: "worker.email.receive",
      }),
      Effect.runPromise
    ),
  scheduled: (_controller, environment) =>
    runEmailMaintenance(environment).pipe(
      observeWorkerExecution({
        telemetry,
        environment: workerRelease(environment),
        operation: "worker.email.scheduled",
      }),
      Effect.runPromise
    ),
});

export default makeEmailWorker(cloudflareWorkerTelemetry);
