import {
  Telemetry,
  encodeTraceParent,
  makeTelemetryService,
  projectHttpStatusClass,
} from "../../../src/shell/observability/operations";
import {
  type WorkerTelemetryEnvironment,
  type WorkerTelemetryEvent,
  type WorkerTraceContinuation,
  type WorkerTraceProjection,
  workerInternalTraceHeader,
} from "./contract";
import { makeWorkerTelemetryAdapter } from "./adapter";

import {
  type DeclaredOutcome,
  DurableTraceContext,
  type SpanDescriptor,
  TelemetryAttempt,
  type TelemetryBreadcrumb,
  TelemetryHttpStatus,
  TelemetryRelease,
  type TelemetryService,
  TelemetryWorkDescriptor,
  type TelemetryWorkRecord,
  type TelemetryWorkSuccess,
  type TelemetryWorkDescriptor as WorkDescriptor,
  maximumTelemetryDurationMilliseconds,
} from "../../../src/shell/observability/contract";
import { Clock, Data, Effect, Option, Schema } from "effect";
import { dual } from "effect/Function";

/** Constructs active Worker spans around closed synchronous export boundaries. */
export const makeWorkerTelemetry = (
  sink:
    | ((record: TelemetryWorkRecord) => void)
    | Readonly<{
        exportWork: (record: TelemetryWorkRecord) => void;
        exportEvent: (event: WorkerTelemetryEvent) => void;
      }>
): TelemetryService =>
  makeTelemetryService(
    makeWorkerTelemetryAdapter(
      typeof sink === "function" ? { exportWork: sink, exportEvent: () => undefined } : sink
    )
  );

/** Cloudflare-native metadata-only structured logging for production Worker entrypoints. */
export const cloudflareWorkerTelemetry = makeWorkerTelemetry({
  exportWork: (record) => {
    Effect.runSync(Effect.log(record));
  },
  exportEvent: (event) => {
    Effect.runSync(Effect.log(event));
  },
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

const completedOutcome = (outcome: TelemetryWorkSuccess["outcome"]): DeclaredOutcome => {
  switch (outcome) {
    case "succeeded":
      return { outcome, error: Option.none(), retryable: false };
    case "rejected":
      return { outcome, error: Option.none(), retryable: false };
    case "failed":
      return { outcome, error: Option.none(), retryable: false };
  }
};

type WorkerObservation = WorkerTraceContinuation &
  Readonly<{
    environment: WorkerTelemetryEnvironment;
    telemetry: TelemetryService;
    operation: "worker.public.fetch" | "worker.core.fetch" | "worker.core.coordinator";
  }>;

const runtimeDescriptor = (
  observation: Readonly<{
    environment: unknown;
    operation: WorkDescriptor["operation"];
  }>
): SpanDescriptor => {
  let trigger: SpanDescriptor["trigger"] = "api";
  if (observation.operation.includes("queue")) trigger = "queue";
  else if (
    observation.operation.includes("scheduled") ||
    observation.operation.includes("maintenance") ||
    observation.operation.includes("alarm")
  ) {
    trigger = "schedule";
  }
  return {
    release: workerDescriptor(workerRelease(observation.environment), observation.operation)
      .release,
    component: observation.operation.startsWith("worker.email") ? "email" : "api",
    operation: observation.operation,
    trigger,
    spanOperation: "fidy.operation",
    workKind: "canonical_operation",
    metadata: { _tag: "None" },
  };
};

const spanBreadcrumb = (descriptor: SpanDescriptor, completed: boolean): TelemetryBreadcrumb => {
  let category: TelemetryBreadcrumb["category"] = "operation";
  let action: TelemetryBreadcrumb["action"] = completed
    ? "operation_completed"
    : "operation_started";
  if (descriptor.workKind === "provider_call") {
    category = "provider";
    action = completed ? "provider_completed" : "provider_started";
  } else if (descriptor.workKind === "model_call") {
    category = "agent";
    action = completed ? "model_completed" : "model_started";
  }
  return {
    category,
    action,
    component: descriptor.component,
    outcome: Option.none(),
    error: Option.none(),
    attempt: Option.none(),
    durationMilliseconds: Option.none(),
  };
};

const runtimeSpan = <A, E, R>(
  work: Effect.Effect<A, E, R>,
  observation: WorkerTraceContinuation &
    Readonly<{
      telemetry: TelemetryService;
    }>,
  descriptor: SpanDescriptor
): Effect.Effect<A, E, R> => {
  const breadcrumbWork = observation.telemetry
    .addBreadcrumb(spanBreadcrumb(descriptor, false))
    .pipe(
      Effect.andThen(
        Effect.onExit(work, () =>
          observation.telemetry.addBreadcrumb(spanBreadcrumb(descriptor, true))
        )
      )
    );
  let observed: Effect.Effect<A, E, R>;
  if (descriptor.operation === "worker.public.fetch") {
    observed = observation.telemetry.rootSpan(descriptor, breadcrumbWork);
  } else if (observation.parent === undefined) {
    observed = observation.telemetry.span(descriptor, breadcrumbWork);
  } else {
    observed = observation.telemetry.continueSpan(observation.parent, descriptor, breadcrumbWork);
  }
  return Effect.provideService(observed, Telemetry, observation.telemetry);
};

const observeWorkerWork = <E, R>(
  work: Effect.Effect<Response, E, R>,
  observation: WorkerObservation
): Effect.Effect<Response, E, R> =>
  runtimeSpan(
    observation.telemetry.observeWork(
      {
        descriptor: workerDescriptor(observation.environment, observation.operation),
        projectSuccess: projectResponse,
      },
      Effect.tap(work, (response) =>
        Effect.ignoreCause(
          Effect.suspend(() =>
            Effect.all(
              [
                observation.telemetry.recordResponseStatus(
                  TelemetryHttpStatus.make(response.status)
                ),
                observation.telemetry.recordOutcome(
                  completedOutcome(projectResponse(response).outcome)
                ),
              ],
              { discard: true }
            )
          )
        )
      )
    ),
    observation,
    runtimeDescriptor(observation)
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

type WorkerExecution = WorkerTraceContinuation &
  Readonly<{
    environment: WorkerTelemetryEnvironment;
    telemetry: TelemetryService;
    operation:
      | "emailAuthentication.processPairingDelivery"
      | "worker.core.queue"
      | "worker.core.scheduled"
      | "worker.core.maintenance"
      | "workflow.browserPairingEmail"
      | "workflow.emailReplacement"
      | "workflow.billingCollection"
      | "workflow.billingRefund"
      | "workflow.proactivityDelivery"
      | "workflow.statementExtraction"
      | "workflow.operationalCanary"
      | "workflow.releaseSmoke"
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
  runtimeSpan(
    observation.telemetry.observeWork(
      {
        descriptor: workerDescriptor(observation.environment, observation.operation),
        projectSuccess: (): TelemetryWorkSuccess => ({
          outcome: "succeeded",
          statusClass: Option.none(),
        }),
      },
      work
    ),
    observation,
    runtimeDescriptor(observation)
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
  observation: WorkerTraceContinuation &
    Readonly<{
      telemetry: TelemetryService;
      descriptor: WorkDescriptor;
      projectSuccess: (value: A) => TelemetryWorkSuccess;
      spanDescriptor: SpanDescriptor;
    }>
): Promise<A> =>
  Effect.tryPromise({
    try: work,
    catch: (original) => new ObservedPromiseFailure({ original }),
  })
    .pipe(
      (effect) =>
        runtimeSpan(
          observation.telemetry.observeWork(
            observation,
            Effect.tap(effect, (value) =>
              Effect.ignoreCause(
                Effect.suspend(() =>
                  observation.telemetry.recordOutcome(
                    completedOutcome(observation.projectSuccess(value).outcome)
                  )
                )
              )
            )
          ),
          observation,
          observation.spanDescriptor
        ),
      Effect.runPromise
    )
    .catch((failure: unknown) =>
      Promise.reject(failure instanceof ObservedPromiseFailure ? failure.original : failure)
    );

const observeWorkerPromiseWork = <A>(
  work: () => Promise<A>,
  observation: WorkerExecution
): Promise<A> =>
  observeNativePromise(work, {
    telemetry: observation.telemetry,
    parent: observation.parent,
    spanDescriptor: runtimeDescriptor(observation),
    descriptor: workerDescriptor(observation.environment, observation.operation),
    projectSuccess: (): TelemetryWorkSuccess => ({
      outcome: "succeeded",
      statusClass: Option.none(),
    }),
  });

type ProviderName = "kapso" | "resend" | "wompi" | "cloudflare-access";
type ResponseObservation = WorkerTraceContinuation &
  Readonly<{
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
    parent: observation.parent,
    spanDescriptor:
      observation.provider === "cloudflare-workers"
        ? runtimeDescriptor(observation)
        : {
            release: workerDescriptor(workerRelease(observation.environment), observation.operation)
              .release,
            component: observation.provider === "cloudflare-workers-ai" ? "agent" : "api",
            operation: observation.operation,
            trigger: "api",
            ...(observation.provider === "cloudflare-workers-ai"
              ? {
                  spanOperation: "agent.model" as const,
                  workKind: "model_call" as const,
                  metadata: { _tag: "Model" as const, model: "workers_ai" as const },
                }
              : {
                  spanOperation: "http.client" as const,
                  workKind: "provider_call" as const,
                  metadata: {
                    _tag: "Provider" as const,
                    provider: observation.provider,
                    attempt: TelemetryAttempt.make(1),
                    status: Option.none(),
                  },
                }),
          },
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
  observation: WorkerTraceContinuation &
    Readonly<{ environment: unknown; telemetry: TelemetryService }>
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
    observation: WorkerTraceContinuation &
      Readonly<{ environment: unknown; telemetry: TelemetryService }>
  ): (work: () => Promise<Response>) => Promise<Response>;
  (
    work: () => Promise<Response>,
    observation: WorkerTraceContinuation &
      Readonly<{ environment: unknown; telemetry: TelemetryService }>
  ): Promise<Response>;
} = dual(2, observeModelRunWork);

export const observeProviderFetch: {
  (
    observation: WorkerTraceContinuation &
      Readonly<{
        environment: unknown;
        telemetry: TelemetryService;
        provider: ProviderName;
      }>
  ): (fetcher: typeof globalThis.fetch) => typeof globalThis.fetch;
  (
    fetcher: typeof globalThis.fetch,
    observation: WorkerTraceContinuation &
      Readonly<{
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

const WorkTraceEnvelope = Schema.Struct({ traceContext: Schema.optionalKey(Schema.Unknown) });

/** Captures only correlation metadata from the current application fiber for durable publication. */
export const captureWorkTrace: Effect.Effect<WorkerTraceProjection> = Effect.flatMap(
  Effect.serviceOption(Telemetry),
  (service) =>
    Option.match(service, {
      onNone: () => Effect.succeed({}),
      onSome: (telemetry) =>
        Effect.map(telemetry.captureDurableContext, (context) =>
          Option.match(context, {
            onNone: () => ({}),
            onSome: (traceContext) => ({ traceContext }),
          })
        ),
    })
);

/** Extracts untrusted correlation independently; invalid metadata never rejects durable domain work. */
export const workTraceParent = (payload: unknown): unknown => {
  try {
    return Option.match(Schema.decodeUnknownOption(WorkTraceEnvelope)(payload), {
      onNone: () => undefined,
      onSome: (envelope) => envelope.traceContext,
    });
  } catch {
    return undefined;
  }
};

/** Captures the active parent before handing the fetch function to a native Promise HTTP client. */
export const captureObservedProviderFetch: {
  (
    observation: WorkerTraceContinuation &
      Readonly<{
        environment: unknown;
        telemetry: TelemetryService;
        provider: ProviderName;
      }>
  ): (fetcher: typeof globalThis.fetch) => Effect.Effect<typeof globalThis.fetch>;
  (
    fetcher: typeof globalThis.fetch,
    observation: WorkerTraceContinuation &
      Readonly<{
        environment: unknown;
        telemetry: TelemetryService;
        provider: ProviderName;
      }>
  ): Effect.Effect<typeof globalThis.fetch>;
} = dual(
  2,
  (
    fetcher: typeof globalThis.fetch,
    observation: WorkerTraceContinuation &
      Readonly<{
        environment: unknown;
        telemetry: TelemetryService;
        provider: ProviderName;
      }>
  ) =>
    Effect.map(observation.telemetry.captureDurableContext, (parent) =>
      observeProviderFetch(fetcher, { ...observation, parent: Option.getOrUndefined(parent) })
    )
);

/** Projects untrusted context independently so invalid diagnostics never reject domain work. */
const projectWorkTrace = (payload: unknown): Effect.Effect<WorkerTraceProjection> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const parent = yield* Effect.sync(() => {
      try {
        return Schema.decodeUnknownOption(DurableTraceContext, { onExcessProperty: "error" })(
          workTraceParent(payload)
        );
      } catch {
        return Option.none();
      }
    });
    return Option.match(
      Option.filter(
        parent,
        (value) =>
          value.capturedAtUnixMilliseconds <= now &&
          now - value.capturedAtUnixMilliseconds <= maximumTelemetryDurationMilliseconds
      ),
      {
        onNone: () => ({}),
        onSome: (traceContext) => ({ traceContext }),
      }
    );
  });

/** Removes raw diagnostic metadata before a decoded domain payload crosses a durable boundary. */
export const sanitizeWorkTrace = <A extends object>(payload: A): Effect.Effect<A> =>
  Effect.map(projectWorkTrace(payload), (projection) => {
    const domain = { ...payload };
    Reflect.deleteProperty(domain, "traceContext");
    return Object.assign(domain, projection);
  });

/** Emits only fresh, strictly decoded private propagation from a durable envelope. */
export const workTraceHeaders = (
  payload: unknown
): Effect.Effect<Readonly<Partial<Record<typeof workerInternalTraceHeader, string>>>> =>
  Effect.map(projectWorkTrace(payload), (projection) =>
    projection.traceContext === undefined
      ? {}
      : { [workerInternalTraceHeader]: encodeTraceParent(projection.traceContext) }
  );

/** Captures only current private trace propagation for a trusted service binding call. */
export const captureTraceHeaders = Effect.flatMap(captureWorkTrace, workTraceHeaders);
