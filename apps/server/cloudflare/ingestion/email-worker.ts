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
});

export default makeEmailWorker(cloudflareWorkerTelemetry);
