/** Runtime release metadata from which a Worker constructs a bounded telemetry descriptor. */
export type WorkerTelemetryEnvironment = {
  readonly RELEASE_GIT_SHA: string;
};
