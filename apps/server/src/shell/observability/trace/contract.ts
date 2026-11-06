import { Schema } from "effect";

/** Opaque trace receipt shared with clients; no server telemetry registry is required. */
export const TelemetryTraceId = Schema.String.check(
  Schema.isPattern(/^(?!0{32}$)[0-9a-f]{32}$/u)
).pipe(Schema.brand("TelemetryTraceId"));
