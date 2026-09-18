import { Effect } from "effect";
import { Telemetry, type TelemetryResource, makeTelemetryService } from "./telemetry";

/** The disabled resource constructs no SDK client or transport and performs no shutdown work. */
export const DisabledTelemetryResource: TelemetryResource = {
  adapter: {
    startSpan: () => Effect.succeedNone,
    finishSpan: () => Effect.void,
    recordOutcome: () => Effect.void,
    recordResponseStatus: () => Effect.void,
    captureFailure: () => Effect.void,
    addBreadcrumb: () => Effect.void,
    recordModelUsage: () => Effect.void,
  },
  close: Effect.void,
};

/** Side-effect-free telemetry service for narrow optional-observability boundaries. */
export const DisabledTelemetry = makeTelemetryService(DisabledTelemetryResource.adapter);

/** Makes every telemetry operation a side-effect-free no-op while preserving wrapped work unchanged. */
export const TelemetryDisabled = Telemetry.layer(Effect.succeed(DisabledTelemetryResource));
