import { Effect, Layer, Option } from "effect";
import { Telemetry } from "./telemetry";

/** Makes every telemetry operation a side-effect-free no-op while preserving wrapped work unchanged. */
export const TelemetryDisabled = Layer.succeed(
  Telemetry,
  Telemetry.of({
    span: (_descriptor, work) => work,
    continueSpan: (_savedContext, _descriptor, work) => work,
    recordOutcome: () => Effect.void,
    captureFailure: () => Effect.void,
    addBreadcrumb: () => Effect.void,
    captureDurableContext: Effect.succeed(Option.none()),
  })
);
