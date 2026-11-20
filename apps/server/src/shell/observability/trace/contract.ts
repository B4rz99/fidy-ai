import { Schema } from "effect";
import { telemetryTraceIdPatternSource } from "~/shell/browser-transport/contract";

export const TelemetryTraceId = Schema.String.check(
  Schema.isPattern(new RegExp(telemetryTraceIdPatternSource, "u"))
).pipe(Schema.brand("TelemetryTraceId"));
