import { expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Option } from "effect";
import {
  errorEnvelopePayloads,
  transactionEnvelopePayloads,
} from "~/shell/testing/telemetry-envelope-fixtures";
import { EnvelopeRecorder, TelemetryEnvelopeRecording } from "./envelope-recorder";
import { deploymentSmokeSourceLocation, runDeploymentSmokeFlow } from "./deployment-smoke";
import { Telemetry } from "./telemetry";

type ErrorPayload = ReturnType<typeof errorEnvelopePayloads>[number];
type TransactionPayload = ReturnType<typeof transactionEnvelopePayloads>[number];
type TraceContext = NonNullable<NonNullable<TransactionPayload["contexts"]>["trace"]>;

const assertSafeDefect = (defect: Option.Option<ErrorPayload>, traceId: string): void => {
  const value = Option.getOrThrow(defect);
  expect(value).toMatchObject({
    contexts: { trace: { trace_id: traceId } },
    tags: {
      component: "ci",
      operation: "observability.deploymentSmokeDefect",
      error: "deployment_smoke_defect",
      retryable: "false",
    },
  });
  expect(value.exception.values[0].stacktrace.frames).toContainEqual(
    expect.objectContaining({
      module: deploymentSmokeSourceLocation.module,
      filename: deploymentSmokeSourceLocation.file,
      function: deploymentSmokeSourceLocation.function,
      lineno: deploymentSmokeSourceLocation.line,
    })
  );
};

const traceOf = (span: Option.Option<TransactionPayload>): Option.Option<TraceContext> =>
  Option.flatMap(span, (value) => Option.fromNullishOr(value.contexts.trace));

const assertParent = (
  child: Option.Option<TransactionPayload>,
  parent: Option.Option<TransactionPayload>
): void =>
  expect(Option.map(traceOf(child), (trace) => trace.parent_span_id)).toEqual(
    Option.map(traceOf(parent), (trace) => trace.span_id)
  );

const assertTraceTopology = (spans: ReadonlyArray<TransactionPayload>, traceId: string): void => {
  const byOperation: ReadonlyMap<string, TransactionPayload> = new Map(
    spans.map((span) => [span.tags.operation, span] as const)
  );
  const find = (operation: string): Option.Option<TransactionPayload> =>
    Option.fromUndefinedOr(byOperation.get(operation));
  const ingress = find("observability.deploymentSmokeIngress");
  const publication = find("observability.deploymentSmokePublish");
  const processing = find("observability.deploymentSmokeProcess");
  const agent = find("observability.deploymentSmokeAgent");
  const model = find("observability.deploymentSmokeModel");
  assertParent(publication, ingress);
  assertParent(processing, publication);
  assertParent(agent, processing);
  assertParent(model, agent);
  assertParent(find("observability.deploymentSmokeProvider"), model);
  assertParent(find("observability.deploymentSmokeExpectedOutcome"), processing);
  expect(
    new Set(spans.map((span) => Option.getOrThrow(traceOf(Option.some(span))).trace_id))
  ).toEqual(new Set([traceId]));
  const expectedOutcome = Option.getOrThrow(find("observability.deploymentSmokeExpectedOutcome"));
  expect(expectedOutcome.tags.outcome).toBe("rejected");
  expect(expectedOutcome.tags.error).toBe("deployment_smoke_expected_outcome");
};

it.effect("emits one safe defect on one causal asynchronous deployment-smoke trace", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryEnvelopeRecording);
    const telemetry = Context.get(services, Telemetry);
    const recorder = Context.get(services, EnvelopeRecorder);
    const emission = yield* runDeploymentSmokeFlow(telemetry);
    const envelopes = yield* recorder.serializedEnvelopes;
    const defects = errorEnvelopePayloads(envelopes);
    const spans = transactionEnvelopePayloads(envelopes);

    expect(defects).toHaveLength(1);
    expect(spans).toHaveLength(7);
    expect(emission.traceId).toMatch(/^[0-9a-f]{32}$/u);
    expect(emission.providerHeadersAreIsolated).toBe(true);
    assertSafeDefect(Option.fromUndefinedOr(defects[0]), emission.traceId);
    const serialized = envelopes.map((bytes) => new TextDecoder().decode(bytes)).join("\n");
    for (const channel of [
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
    ]) {
      expect(serialized).not.toContain(`deployment-smoke-${channel}-sentinel`);
    }
    assertTraceTopology(spans, emission.traceId);
    expect(Option.isSome(emission.publicationContext)).toBe(true);
  })
);
