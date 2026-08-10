import { Effect, Option, Schema } from "effect";
import {
  DurableTraceContext,
  TelemetryAttempt,
  TelemetryCount,
  TelemetryDuration,
  TelemetryHttpStatus,
} from "./protocol";
import type { TelemetryService } from "./telemetry";

/** Metadata-only reason the rollout smoke could not produce its required trace coordinates. */
export class DeploymentSmokeFlowError extends Schema.TaggedErrorClass<DeploymentSmokeFlowError>()(
  "DeploymentSmokeFlowError",
  { reason: Schema.Literal("trace-unavailable") }
) {}

/** Coordinates and boundary checks retained after the synthetic asynchronous flow completes. */
export type DeploymentSmokeEmission = Readonly<{
  traceId: DurableTraceContext["traceId"];
  publicationContext: Option.Option<DurableTraceContext>;
  providerHeadersAreIsolated: boolean;
}>;

/** Original source coordinates expected after production source-map symbolication. */
export const deploymentSmokeSourceLocation = {
  module: "src/shell/observability/deployment-smoke",
  file: "src/shell/observability/deployment-smoke.ts",
  function: "raiseDeploymentSmokeDefect",
  line: 174,
} as const;

const successfulStatusCode = 200;
const attempt = TelemetryAttempt.make(1);
const noDelay = TelemetryDuration.make(0);
const oneInput = TelemetryCount.make(1);
const successfulHttpStatus = TelemetryHttpStatus.make(successfulStatusCode);

const ingressDescriptor = {
  component: "ci",
  operation: "observability.deploymentSmokeIngress",
  trigger: "ci",
  spanOperation: "http.server",
  workKind: "http_request",
  metadata: {
    _tag: "Http",
    method: "POST",
    route: "/deployment-smoke",
    status: Option.some(successfulHttpStatus),
  },
} as const;

const publicationDescriptor = {
  component: "ci",
  operation: "observability.deploymentSmokePublish",
  trigger: "ci",
  spanOperation: "queue.publish",
  workKind: "queue_publication",
  metadata: {
    _tag: "Queue",
    attempt,
    inputCount: oneInput,
    delayMilliseconds: noDelay,
  },
} as const;

const processingDescriptor = {
  component: "ci",
  operation: "observability.deploymentSmokeProcess",
  trigger: "queue",
  spanOperation: "queue.process",
  workKind: "queue_attempt",
  metadata: {
    _tag: "Queue",
    attempt,
    inputCount: oneInput,
    delayMilliseconds: noDelay,
  },
} as const;

const agentDescriptor = {
  component: "ci",
  operation: "observability.deploymentSmokeAgent",
  trigger: "queue",
  spanOperation: "agent.turn",
  workKind: "hosted_turn",
  metadata: { _tag: "None" },
} as const;

const modelDescriptor = {
  component: "ci",
  operation: "observability.deploymentSmokeModel",
  trigger: "queue",
  spanOperation: "agent.model",
  workKind: "model_call",
  metadata: { _tag: "Model", model: "gpt_5_6_luna" },
} as const;

const providerDescriptor = {
  component: "ci",
  operation: "observability.deploymentSmokeProvider",
  trigger: "queue",
  spanOperation: "http.client",
  workKind: "provider_call",
  metadata: {
    _tag: "Provider",
    provider: "openai",
    attempt,
    status: Option.some(successfulHttpStatus),
  },
} as const;

const expectedOutcomeDescriptor = {
  component: "ci",
  operation: "observability.deploymentSmokeExpectedOutcome",
  trigger: "queue",
  spanOperation: "fidy.operation",
  workKind: "ci_scenario",
  metadata: { _tag: "None" },
} as const;

const forbiddenSentinelChannels = [
  "http",
  "canonical",
  "database",
  "queue",
  "schedule",
  "agent-model",
  "provider",
  "error-message",
  "breadcrumb",
  "context",
] as const;

const deploymentSmokeSentinel = (channel: (typeof forbiddenSentinelChannels)[number]): string =>
  ["deployment", "smoke", channel, "sentinel"].join("-");

/** Fixed hostile values placed in every forbidden diagnostic channel. */
export const deploymentSmokeForbiddenSentinels: ReadonlyArray<string> =
  forbiddenSentinelChannels.map(deploymentSmokeSentinel);

/** Checks exact serialized envelopes before the network smoke is allowed to start. */
export const deploymentSmokeEnvelopesAreSafe = (envelopes: ReadonlyArray<Uint8Array>): boolean => {
  const serialized = envelopes.map((value) => new TextDecoder().decode(value)).join("\n");
  return deploymentSmokeForbiddenSentinels.every((sentinel) => !serialized.includes(sentinel));
};

const DurableTraceContextJson = Schema.fromJsonString(DurableTraceContext);

const crossSyntheticDurableBoundary = (
  context: DurableTraceContext
): Effect.Effect<DurableTraceContext, DeploymentSmokeFlowError> =>
  Schema.encodeEffect(DurableTraceContextJson)(context).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(DurableTraceContextJson)),
    Effect.mapError(() => DeploymentSmokeFlowError.make({ reason: "trace-unavailable" }))
  );

const forbiddenPropagationHeaders = new Set([
  "b3",
  "baggage",
  "sentry-trace",
  "traceparent",
  "tracestate",
]);

/** Proves the safely substituted provider request contains no Fidy propagation carrier. */
export const providerHeadersAreIsolated = (headers: ReadonlyArray<string>): boolean =>
  headers.every((header) => !forbiddenPropagationHeaders.has(header.toLowerCase()));

/**
 * The one intentional defect site. The hostile properties prove cause content is not projected;
 * only this function's source coordinates may survive into the event stack.
 */
export const raiseDeploymentSmokeDefect = (): Error =>
  Object.assign(new Error(deploymentSmokeSentinel("error-message")), {
    request: deploymentSmokeSentinel("http"),
    canonicalInput: deploymentSmokeSentinel("canonical"),
    databaseRow: deploymentSmokeSentinel("database"),
    queuePayload: deploymentSmokeSentinel("queue"),
    scheduleInput: deploymentSmokeSentinel("schedule"),
    modelPrompt: deploymentSmokeSentinel("agent-model"),
    providerEvidence: deploymentSmokeSentinel("provider"),
    breadcrumb: deploymentSmokeSentinel("breadcrumb"),
    arbitraryContext: deploymentSmokeSentinel("context"),
  });

const substitutedProviderRequestHeaders = (): ReadonlyArray<string> => {
  const request = new Request("https://provider.invalid/v1/substituted-model", {
    method: "POST",
    headers: { accept: "application/json", "content-type": "application/json" },
  });
  return Array.from(request.headers.keys());
};

const substitutedProviderWork = (telemetry: TelemetryService): Effect.Effect<boolean> =>
  telemetry.span(
    providerDescriptor,
    Effect.gen(function* () {
      yield* telemetry.captureFailure({
        _tag: "Defect",
        component: "ci",
        operation: "observability.deploymentSmokeDefect",
        error: "deployment_smoke_defect",
        cause: raiseDeploymentSmokeDefect(),
      });
      return providerHeadersAreIsolated(substitutedProviderRequestHeaders());
    })
  );

const substitutedHostedWork = (telemetry: TelemetryService): Effect.Effect<boolean> =>
  telemetry.span(
    agentDescriptor,
    telemetry.span(modelDescriptor, substitutedProviderWork(telemetry))
  );

const expectedOutcome = (telemetry: TelemetryService): Effect.Effect<void> =>
  telemetry.span(
    expectedOutcomeDescriptor,
    telemetry.recordOutcome({
      outcome: "rejected",
      error: Option.some("deployment_smoke_expected_outcome"),
      retryable: false,
    })
  );

/**
 * Emits the fixed rollout trace. The publication span ends before continuation begins, matching a
 * durable queue hand-off without writing User or domain records in the production database.
 */
export const runDeploymentSmokeFlow = (
  telemetry: TelemetryService
): Effect.Effect<DeploymentSmokeEmission, DeploymentSmokeFlowError> =>
  Effect.gen(function* () {
    const publicationContext = yield* telemetry.rootSpan(
      ingressDescriptor,
      telemetry.span(publicationDescriptor, telemetry.captureDurableContext)
    );
    const context = yield* Option.match(publicationContext, {
      onNone: () => Effect.fail(DeploymentSmokeFlowError.make({ reason: "trace-unavailable" })),
      onSome: Effect.succeed,
    });
    const continuedContext = yield* crossSyntheticDurableBoundary(context);
    const providerBoundaryIsolated = yield* telemetry.continueSpan(
      continuedContext,
      processingDescriptor,
      Effect.gen(function* () {
        const isolated = yield* substitutedHostedWork(telemetry);
        yield* expectedOutcome(telemetry);
        return isolated;
      })
    );
    return {
      traceId: context.traceId,
      publicationContext,
      providerHeadersAreIsolated: providerBoundaryIsolated,
    };
  });
