/** Provider-neutral observability boundary published for runtime adapters. */
export {
  DisabledTelemetryResource,
  TelemetryAttempt,
  TelemetryGitRevision,
  TelemetryHttpStatus,
  TelemetryRelease,
  TelemetryWorkDescriptor,
  TelemetryWorkRecord,
  projectHttpStatusClass,
} from "./contract";
export type { TelemetryAdapter, TelemetryService, TelemetryWorkSuccess } from "./contract";
export { DisabledTelemetry, makeTelemetryService } from "./operations";
