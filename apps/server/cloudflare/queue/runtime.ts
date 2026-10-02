import type { TelemetryService } from "../../src/shell/observability/contract";
import type { CoreQueueHandler } from "./contract";
import { dispatchCoreQueue } from "./internal/dispatch";
import { observeWorkerPromise } from "../runtime/telemetry/operations";

/** Construct the identity-only Queue handoff boundary with its existing closed Work observation. */
export const makeCoreQueue =
  (telemetry: TelemetryService): CoreQueueHandler =>
  (batch, environment) =>
    observeWorkerPromise(() => dispatchCoreQueue({ batch, environment }), {
      environment,
      telemetry,
      operation: "worker.core.queue",
    });
