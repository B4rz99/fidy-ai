import {
  DisabledTelemetryResource,
  TelemetryAttempt,
  TelemetryHttpStatus,
  TelemetryRelease,
  type TelemetryService,
  TelemetryWorkDescriptor,
  type TelemetryWorkRecord,
  type TelemetryWorkSuccess,
  type TelemetryWorkDescriptor as WorkDescriptor,
  makeTelemetryService,
  projectHttpStatusClass,
} from "@fidy/server/telemetry";
import { Data, Effect, Option, Schema } from "effect";
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
): Effect.Effect<Response, E, R> =>
  observation.telemetry.observeWork(
    {
      descriptor: workerDescriptor(observation.environment, observation.operation),
      projectSuccess: projectResponse,
    },
    work
  );

const workerDescriptor = (
  environment: WorkerTelemetryEnvironment,
  operation: WorkDescriptor["operation"]
): WorkDescriptor =>
  TelemetryWorkDescriptor.make({
    release: Option.getOrElse(
      Schema.decodeOption(TelemetryRelease)(environment.RELEASE_GIT_SHA),
      () => "unknown" as const
    ),
    operation,
    provider: Option.some("cloudflare-workers"),
    attempt: TelemetryAttempt.make(1),
  });

type WorkerExecution = Readonly<{
  environment: WorkerTelemetryEnvironment;
  telemetry: TelemetryService;
  operation:
    | "worker.core.queue"
    | "worker.core.scheduled"
    | "workflow.onboardingEmail"
    | "workflow.browserPairingEmail"
    | "workflow.emailReplacement"
    | "workflow.billingCollection"
    | "workflow.statementExtraction"
    | "worker.core.coordinator"
    | "worker.core.alarm"
    | "worker.email.receive"
    | "worker.email.scheduled";
}>;

/** Observes a durable or Email Worker invocation without changing its Effect exit or payload. */
const observeWorkerExecutionWork = <E, R>(
  work: Effect.Effect<void, E, R>,
  observation: WorkerExecution
): Effect.Effect<void, E, R> =>
  observation.telemetry.observeWork(
    {
      descriptor: workerDescriptor(observation.environment, observation.operation),
      projectSuccess: (): TelemetryWorkSuccess => ({
        outcome: "succeeded",
        statusClass: Option.none(),
      }),
    },
    work
  );

const ReleaseBinding = Schema.Struct({ RELEASE_GIT_SHA: Schema.String });

/** Reads only the release binding from a platform environment; never exports another binding. */
export const workerRelease = (environment: unknown): WorkerTelemetryEnvironment => ({
  RELEASE_GIT_SHA: Option.match(Schema.decodeUnknownOption(ReleaseBinding)(environment), {
    onNone: () => "",
    onSome: (binding) => binding.RELEASE_GIT_SHA,
  }),
});

class ObservedPromiseFailure extends Data.TaggedError("ObservedPromiseFailure")<{
  readonly original: unknown;
}> {}

/** Gives a native Cloudflare Promise one closed Work record, preserving its exact resolution/rejection. */
const observeNativePromise = <A>(
  work: () => Promise<A>,
  observation: Readonly<{
    telemetry: TelemetryService;
    descriptor: WorkDescriptor;
    projectSuccess: (value: A) => TelemetryWorkSuccess;
  }>
): Promise<A> =>
  Effect.tryPromise({
    try: work,
    catch: (original) => new ObservedPromiseFailure({ original }),
  })
    .pipe((effect) => observation.telemetry.observeWork(observation, effect), Effect.runPromise)
    .catch((failure: unknown) =>
      Promise.reject(failure instanceof ObservedPromiseFailure ? failure.original : failure)
    );

const observeWorkerPromiseWork = <A>(
  work: () => Promise<A>,
  observation: WorkerExecution
): Promise<A> =>
  observeNativePromise(work, {
    telemetry: observation.telemetry,
    descriptor: workerDescriptor(observation.environment, observation.operation),
    projectSuccess: (): TelemetryWorkSuccess => ({
      outcome: "succeeded",
      statusClass: Option.none(),
    }),
  });

type ProviderName = "kapso" | "resend" | "wompi" | "cloudflare-access";
type ResponseObservation = Readonly<{
  environment: unknown;
  telemetry: TelemetryService;
  operation: WorkDescriptor["operation"];
  provider: ProviderName | "cloudflare-workers-ai" | "cloudflare-workers";
}>;

const observeResponsePromise = (
  work: () => Promise<Response>,
  observation: ResponseObservation
): Promise<Response> =>
  observeNativePromise(work, {
    telemetry: observation.telemetry,
    descriptor: TelemetryWorkDescriptor.make({
      ...workerDescriptor(workerRelease(observation.environment), observation.operation),
      provider: Option.some(observation.provider),
    }),
    projectSuccess: projectResponse,
  });

/** Projects a coordinator HTTP result separately from durable invocation success. */
const observeWorkerResponseWork = (
  work: () => Promise<Response>,
  observation: WorkerExecution
): Promise<Response> =>
  observeResponsePromise(work, { ...observation, provider: "cloudflare-workers" });

/** Observes a direct Workers AI invocation without reading inference request or response content. */
const observeModelRunWork = (
  work: () => Promise<Response>,
  observation: Readonly<{ environment: unknown; telemetry: TelemetryService }>
): Promise<Response> =>
  observeResponsePromise(work, {
    ...observation,
    operation: "model.workersAi",
    provider: "cloudflare-workers-ai",
  });

/** Supplies only closed provider response metadata beneath Outbound HTTP's request policy. */
const observeProviderFetchWork = (
  fetcher: typeof globalThis.fetch,
  observation: Readonly<{
    environment: unknown;
    telemetry: TelemetryService;
    provider: ProviderName;
  }>
): typeof globalThis.fetch =>
  Object.assign(
    (
      input: Parameters<typeof globalThis.fetch>[0],
      init?: Parameters<typeof globalThis.fetch>[1]
    ) =>
      observeResponsePromise(() => fetcher(input, init), {
        ...observation,
        operation: "provider.request",
      }),
    { preconnect: fetcher.preconnect }
  );

export const observeModelRun: {
  (
    observation: Readonly<{ environment: unknown; telemetry: TelemetryService }>
  ): (work: () => Promise<Response>) => Promise<Response>;
  (
    work: () => Promise<Response>,
    observation: Readonly<{ environment: unknown; telemetry: TelemetryService }>
  ): Promise<Response>;
} = dual(2, observeModelRunWork);

export const observeProviderFetch: {
  (
    observation: Readonly<{
      environment: unknown;
      telemetry: TelemetryService;
      provider: ProviderName;
    }>
  ): (fetcher: typeof globalThis.fetch) => typeof globalThis.fetch;
  (
    fetcher: typeof globalThis.fetch,
    observation: Readonly<{
      environment: unknown;
      telemetry: TelemetryService;
      provider: ProviderName;
    }>
  ): typeof globalThis.fetch;
} = dual(2, observeProviderFetchWork);

export const observeWorkerResponse: {
  (observation: WorkerExecution): (work: () => Promise<Response>) => Promise<Response>;
  (work: () => Promise<Response>, observation: WorkerExecution): Promise<Response>;
} = dual(2, observeWorkerResponseWork);

export const observeWorkerPromise: {
  (observation: WorkerExecution): <A>(work: () => Promise<A>) => Promise<A>;
  <A>(work: () => Promise<A>, observation: WorkerExecution): Promise<A>;
} = dual(2, observeWorkerPromiseWork);

export const observeWorkerExecution: {
  (
    observation: WorkerExecution
  ): <E, R>(work: Effect.Effect<void, E, R>) => Effect.Effect<void, E, R>;
  <E, R>(work: Effect.Effect<void, E, R>, observation: WorkerExecution): Effect.Effect<void, E, R>;
} = dual(2, observeWorkerExecutionWork);

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
