import { Schema } from "effect";
import { telemetryTraceIdPatternSource } from "~/shell/browser-transport/contract";

/** Opaque trace receipt shared with clients; no server telemetry registry is required. */
export const TelemetryTraceId = Schema.String.check(
  Schema.isPattern(new RegExp(telemetryTraceIdPatternSource, "u"))
).pipe(Schema.brand("TelemetryTraceId"));
