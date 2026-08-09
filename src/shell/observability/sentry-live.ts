import { Effect } from "effect";
import { getTelemetryBootstrap } from "./telemetry-bootstrap";
import { Telemetry } from "./telemetry";

/**
 * Runtime Telemetry layer backed exclusively by the preload handoff. Missing preload fails runtime
 * assembly rather than constructing a second, late Sentry client.
 */
export const SentryLive = Telemetry.layer(
  Effect.flatMap(Effect.sync(getTelemetryBootstrap), Effect.fromResult).pipe(
    Effect.map((bootstrap) => bootstrap.resource)
  )
);
