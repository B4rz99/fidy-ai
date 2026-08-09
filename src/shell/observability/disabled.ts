import { Effect, Option } from "effect";
import { Telemetry, type TelemetryResource } from "./telemetry";

/** The disabled resource constructs no SDK client or transport and performs no shutdown work. */
export const DisabledTelemetryResource: TelemetryResource = {
  adapter: {
    startSpan: () => Effect.succeed(Option.none()),
    finishSpan: () => Effect.void,
    recordOutcome: () => Effect.void,
    captureFailure: () => Effect.void,
    addBreadcrumb: () => Effect.void,
    recordModelUsage: () => Effect.void,
  },
  close: Effect.void,
};

/** Makes every telemetry operation a side-effect-free no-op while preserving wrapped work unchanged. */
export const TelemetryDisabled = Telemetry.layer(Effect.succeed(DisabledTelemetryResource));
