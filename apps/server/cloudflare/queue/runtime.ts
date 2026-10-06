import type { TelemetryService } from "../../src/shell/observability/contract";
import type { CoreQueueHandler } from "./contract";
import { QueueDeliveryUnavailable, dispatchCoreQueue } from "./internal/dispatch";
import { observeWorkerExecution } from "../runtime/telemetry/operations";
import { Effect } from "effect";

/** Construct the identity-only Queue handoff boundary with its existing closed Work observation. */
export const makeCoreQueue =
  (telemetry: TelemetryService): CoreQueueHandler =>
  (batch, environment) =>
    dispatchCoreQueue({ batch, environment })
      .pipe(
        observeWorkerExecution({ environment, telemetry, operation: "worker.core.queue" }),
        Effect.runPromise
      )
      .catch((failure: unknown) =>
        Promise.reject(failure instanceof QueueDeliveryUnavailable ? failure.original : failure)
      );
