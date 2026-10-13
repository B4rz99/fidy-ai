import { dual } from "effect/Function";
import { Cause, Effect, Exit, Option } from "effect";
import {
  HostedInferenceError,
  type HostedInferenceFailureReason,
} from "../../../src/shell/hosted-inference/contract";
import type {
  DeclaredOutcome,
  SpanDescriptor,
  TelemetryCode,
  TelemetryRelease,
  TelemetryService,
} from "../../../src/shell/observability/contract";
import { Telemetry } from "../../../src/shell/observability/operations";

type HostedObservation = Readonly<{
  trigger: "api" | "queue" | "kapso_webhook";
  parent: Option.Option<unknown>;
  release: TelemetryRelease;
}>;

type ApplicationSpan = Omit<Extract<SpanDescriptor, { metadata: { _tag: "None" } }>, "workKind"> & {
  readonly workKind: "canonical_operation" | "hosted_turn" | "model_round";
};

const modelFailureCodes: Readonly<
  Record<HostedInferenceFailureReason["_tag"], TelemetryCode<"error">>
> = {
  InvalidAuthority: "authentication_failed",
  CapacityExceeded: "capacity_exceeded",
  ActiveRequestCapacityExceeded: "capacity_exceeded",
  InvalidOutput: "model_response_rejected",
  ProviderUnavailable: "model_unavailable",
  ProviderQuotaExceeded: "capacity_exceeded",
  ResourceLimit: "capacity_exceeded",
  AdmissionUnavailable: "model_unavailable",
  StructuredOutputExceeded: "model_response_rejected",
  StructuredOutputTimedOut: "timeout",
};

const classifiedModelFailure = (cause: Cause.Cause<unknown>): DeclaredOutcome => {
  const error = Cause.findErrorOption(cause);
  if (Option.exists(error, Cause.isTimeoutError)) {
    return { outcome: "failed", error: Option.some("timeout"), retryable: false };
  }
  if (Option.isNone(error) || !(error.value instanceof HostedInferenceError)) {
    return { outcome: "failed", error: Option.some("operational_failure"), retryable: false };
  }
  const failure = error.value;
  const code = modelFailureCodes[failure.reason._tag];
  return code === "model_response_rejected" || code === "authentication_failed"
    ? { outcome: "rejected", error: Option.some(code), retryable: false }
    : { outcome: "failed", error: Option.some(code), retryable: failure.retryable };
};

const isPureInterruption = (cause: Cause.Cause<unknown>): boolean =>
  Cause.hasInterrupts(cause) && !Cause.hasDies(cause) && !Cause.hasFails(cause);

const finishApplication = (
  telemetry: TelemetryService,
  descriptor: ApplicationSpan,
  exit: Exit.Exit<unknown, unknown>
): Effect.Effect<void> => {
  if (Exit.isSuccess(exit)) return Effect.void;
  if (isPureInterruption(exit.cause)) {
    return telemetry.recordOutcome({
      outcome: "interrupted",
      error: Option.none(),
      retryable: false,
    });
  }
  const outcome: DeclaredOutcome =
    descriptor.workKind === "model_round"
      ? classifiedModelFailure(exit.cause)
      : { outcome: "failed", error: Option.some("operational_failure"), retryable: false };
  const classified = telemetry.recordOutcome(outcome);
  if (outcome.outcome === "rejected") return classified;
  return classified.pipe(
    Effect.andThen(
      telemetry.captureFailure(
        Cause.hasDies(exit.cause)
          ? {
              _tag: "Defect",
              component: descriptor.component,
              operation: descriptor.operation,
              error: "unexpected_defect",
              cause: exit.cause,
            }
          : {
              _tag: "ExhaustedOperationalFailure",
              component: descriptor.component,
              operation: descriptor.operation,
              error: Option.getOrElse(outcome.error, () => "operational_failure" as const),
              provider:
                descriptor.workKind === "model_round"
                  ? Option.some("cloudflare-workers-ai")
                  : Option.none(),
              retryable: outcome.retryable,
              cause: exit.cause,
            }
      )
    )
  );
};

/** Observe closed application work in the caller's trace without requiring telemetry in fixtures. */
const observeApplicationOperationWork = <A, E, R>(
  work: Effect.Effect<A, E, R>,
  descriptor: ApplicationSpan,
  parent: Option.Option<unknown> = Option.none()
): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.serviceOption(Telemetry), (service) => {
    if (Option.isNone(service)) return work;
    const telemetry = service.value;
    const observed = Effect.onExit(work, (exit) => finishApplication(telemetry, descriptor, exit));
    return Option.match(parent, {
      onNone: () => telemetry.span(descriptor, observed),
      onSome: (context) => telemetry.continueSpan(context, descriptor, observed),
    });
  });

const firstClientErrorStatus = 400;
const firstServerErrorStatus = 500;
const responseOutcome = (response: Response): DeclaredOutcome => {
  if (response.status >= firstServerErrorStatus) {
    return { outcome: "failed", error: Option.some("operational_failure"), retryable: false };
  }
  if (response.status >= firstClientErrorStatus) {
    return { outcome: "rejected", error: Option.none(), retryable: false };
  }
  return { outcome: "succeeded", error: Option.none(), retryable: false };
};

/** HTTP status is sufficient to classify canonical refusals; response bodies stay private. */
const observeApplicationResponseWork = <E, R>(
  work: Effect.Effect<Response, E, R>,
  descriptor: ApplicationSpan,
  parent: Option.Option<unknown> = Option.none()
): Effect.Effect<Response, E, R> =>
  observeApplicationOperationWork(
    Effect.tap(work, (response) =>
      Effect.flatMap(Effect.serviceOption(Telemetry), (service) =>
        Option.match(service, {
          onNone: () => Effect.void,
          onSome: (telemetry) => telemetry.recordOutcome(responseOutcome(response)),
        })
      )
    ),
    descriptor,
    parent
  );

/** Observe one catalog operation through the shared metadata-only application boundary. */
const observeCanonicalResponseWork = <E, R>(
  work: Effect.Effect<Response, E, R>,
  operation: ApplicationSpan["operation"]
): Effect.Effect<Response, E, R> =>
  observeApplicationResponse(work, {
    component: "api",
    operation,
    trigger: "api",
    spanOperation: "fidy.operation",
    workKind: "canonical_operation",
    metadata: { _tag: "None" },
  });

/** Give each hosted Turn a closed response classification before Promise runtime settlement. */
const observeHostedResponseWork = <E, R>(
  work: Effect.Effect<Response, E, R>,
  observation: HostedObservation
): Effect.Effect<Response, E, R> =>
  observeApplicationResponseWork(
    work,
    {
      release: observation.release,
      component: "agent",
      operation: "agent.hostedTurn",
      trigger: observation.trigger,
      spanOperation: "agent.turn",
      workKind: "hosted_turn",
      metadata: { _tag: "None" },
    },
    observation.parent
  );

export const observeApplicationOperation: {
  (descriptor: ApplicationSpan): <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  <A, E, R>(work: Effect.Effect<A, E, R>, descriptor: ApplicationSpan): Effect.Effect<A, E, R>;
} = dual(2, observeApplicationOperationWork);

export const observeApplicationResponse: {
  (
    descriptor: ApplicationSpan
  ): <E, R>(work: Effect.Effect<Response, E, R>) => Effect.Effect<Response, E, R>;
  <E, R>(
    work: Effect.Effect<Response, E, R>,
    descriptor: ApplicationSpan
  ): Effect.Effect<Response, E, R>;
} = dual(2, observeApplicationResponseWork);

export const observeCanonicalResponse: {
  (
    operation: ApplicationSpan["operation"]
  ): <E, R>(work: Effect.Effect<Response, E, R>) => Effect.Effect<Response, E, R>;
  <E, R>(
    work: Effect.Effect<Response, E, R>,
    operation: ApplicationSpan["operation"]
  ): Effect.Effect<Response, E, R>;
} = dual(2, observeCanonicalResponseWork);

export const observeHostedResponse: {
  (
    observation: HostedObservation
  ): <E, R>(work: Effect.Effect<Response, E, R>) => Effect.Effect<Response, E, R>;
  <E, R>(
    work: Effect.Effect<Response, E, R>,
    observation: HostedObservation
  ): Effect.Effect<Response, E, R>;
} = dual(2, observeHostedResponseWork);
