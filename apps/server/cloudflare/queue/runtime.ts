import type { TelemetryService } from "../../src/shell/observability/contract";
import type { CoreQueueHandler } from "./contract";
import { dispatchCoreQueue } from "./internal/dispatch";
import { observeWorkerExecution } from "../runtime/telemetry/operations";
import { Effect } from "effect";

export const coreQueue =
  (telemetry: TelemetryService): CoreQueueHandler =>
  (batch, environment) =>
    dispatchCoreQueue({ batch, environment }).pipe(
      observeWorkerExecution({ environment, telemetry, operation: "worker.core.queue" }),
      Effect.catchTag("QueueDeliveryUnavailable", ({ original }) => Effect.die(original)),
      Effect.orDie
    );
