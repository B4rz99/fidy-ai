import { refuseUnverifiedEmail } from "./runtime";
import { Effect } from "effect";
import type { TelemetryService } from "../../src/shell/observability/contract";
import type { ForwardedEmailMessage } from "./contract";
import {
  cloudflareWorkerTelemetry,
  observeWorkerExecution,
  workerRelease,
} from "../runtime/telemetry/operations";

type EmailWorker = Readonly<{
  email: (message: ForwardedEmailMessage, environment: unknown) => Promise<void>;
}>;

/** Refuse native delivery until institution verification and Connection admission exist;
 * the addressed User recovers previously admitted work from its own alarm.
 */
export const makeEmailWorker = (telemetry: TelemetryService): EmailWorker => ({
  email: (message, environment) =>
    refuseUnverifiedEmail(message).pipe(
      observeWorkerExecution({
        telemetry,
        environment: workerRelease(environment),
        operation: "worker.email.receive",
      }),
      Effect.runPromise
    ),
});

export default makeEmailWorker(cloudflareWorkerTelemetry);
