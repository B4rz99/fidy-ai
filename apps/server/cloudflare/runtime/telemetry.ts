import {
  DisabledTelemetryResource,
  TelemetryAttempt,
  TelemetryHttpStatus,
  TelemetryRelease,
  type TelemetryService,
  TelemetryWorkDescriptor,
  type TelemetryWorkRecord,
  type TelemetryWorkSuccess,
  makeTelemetryService,
  projectHttpStatusClass,
} from "@fidy/server/telemetry";
import { Effect, Option, Schema } from "effect";
import { dual } from "effect/Function";

/** Runtime release metadata from which a Worker constructs a bounded telemetry descriptor. */
export type WorkerTelemetryEnvironment = {
  readonly RELEASE_GIT_SHA: string;
};

/** Constructs the shared telemetry service around one synchronous, closed-record export boundary. */
export const makeWorkerTelemetry = (
  exportWork: (record: TelemetryWorkRecord) => void
): TelemetryService =>
  makeTelemetryService({
    ...DisabledTelemetryResource.adapter,
    exportWork,
  });

/** Cloudflare-native structured logging for the production Worker entrypoints. */
export const cloudflareWorkerTelemetry = makeTelemetryService({
  ...DisabledTelemetryResource.adapter,
  exportWork: (record) => {
    Effect.runSync(Effect.log(record));
  },
  captureFailure: (_span, failure) =>
    failure.operation === "http.supportRecovery" && failure.error === "unexpected_defect"
      ? Effect.log({
          component: "api",
          operation: "http.supportRecovery",
          error: "unexpected_defect",
        })
      : Effect.void,
});

const firstClientFailureStatus = 400;
const firstServerFailureStatus = 500;

const projectResponse = (response: Response): TelemetryWorkSuccess => {
  let outcome: TelemetryWorkSuccess["outcome"] = "succeeded";
  if (response.status >= firstServerFailureStatus) outcome = "failed";
  else if (response.status >= firstClientFailureStatus) outcome = "rejected";
  return {
    outcome,
    statusClass: Option.some(projectHttpStatusClass(TelemetryHttpStatus.make(response.status))),
  };
};

type WorkerObservation = Readonly<{
  environment: WorkerTelemetryEnvironment;
  telemetry: TelemetryService;
  operation: "worker.public.fetch" | "worker.core.fetch";
}>;

const observeWorkerWork = <E, R>(
  work: Effect.Effect<Response, E, R>,
  observation: WorkerObservation
): Effect.Effect<Response, E, R> => {
  const release = Option.getOrElse(
    Schema.decodeOption(TelemetryRelease)(observation.environment.RELEASE_GIT_SHA),
    () => "unknown" as const
  );
  return observation.telemetry.observeWork(
    {
      descriptor: TelemetryWorkDescriptor.make({
        release,
        operation: observation.operation,
        provider: Option.some("cloudflare-workers"),
        attempt: TelemetryAttempt.make(1),
      }),
      projectSuccess: projectResponse,
    },
    work
  );
};

/**
 * Gives one Worker invocation one owning Work span. Invalid release configuration is represented by
 * the bounded `unknown` release rather than disabling observation or changing authoritative Work.
 */
export const observeWorkerRequest: {
  (
    observation: WorkerObservation
  ): <E, R>(work: Effect.Effect<Response, E, R>) => Effect.Effect<Response, E, R>;
  <E, R>(
    work: Effect.Effect<Response, E, R>,
    observation: WorkerObservation
  ): Effect.Effect<Response, E, R>;
} = dual(2, observeWorkerWork);
