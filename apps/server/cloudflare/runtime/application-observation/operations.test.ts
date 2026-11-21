import {
  HostedInferenceError,
  type HostedInferenceFailureReason,
} from "../../../src/shell/hosted-inference/contract";
import { CanonicalOperationId } from "../../../src/core/canonical-operations/contract";
import { it } from "@effect/vitest";
import { Data, Effect, Exit, Option } from "effect";
import { expect } from "vitest";
import assert from "node:assert/strict";
import {
  type DeclaredOutcome,
  type SpanDescriptor,
  TelemetrySpanId,
  TelemetryTraceId,
} from "../../../src/shell/observability/contract";
import {
  DisabledTelemetryResource,
  Telemetry,
  makeTelemetryService,
} from "../../../src/shell/observability/operations";
import {
  observeApplicationOperation,
  observeCanonicalResponse,
  observeHostedResponse,
} from "./operations";

const SpanMetadata = Data.taggedEnum<SpanDescriptor["metadata"]>();

const FailureReason = Data.taggedEnum<HostedInferenceFailureReason>();

it.effect(
  "classifies canonical refusals and unavailable responses without reading private response content",
  () =>
    Effect.gen(function* () {
      const outcomes: DeclaredOutcome[] = [];
      const descriptors: SpanDescriptor[] = [];

      const telemetry = makeTelemetryService({
        ...DisabledTelemetryResource.adapter,
        startSpan: (descriptor) =>
          Effect.sync(() => {
            descriptors.push(descriptor);

            return Option.some({
              traceId: TelemetryTraceId.make("1".repeat(32)),
              spanId: TelemetrySpanId.make("2".repeat(16)),
              sampled: true,
              state: undefined,
            });
          }),
        recordOutcome: (_span, outcome) =>
          Effect.sync(() => {
            outcomes.push(outcome);
          }),
      });

      yield* Effect.forEach(
        [
          [200, "succeeded"],
          [403, "rejected"],
          [503, "failed"],
        ] as const,
        Effect.fnUntraced(function* ([status, outcome]) {
          const response = new Response("private-financial-body", { status });
          expect(
            yield* observeCanonicalResponse(
              Effect.succeed(response),
              CanonicalOperationId.make("transactions.listTransactions")
            ).pipe(Effect.provideService(Telemetry, telemetry))
          ).toBe(response);
          expect(response.bodyUsed).toBe(false);
          expect(outcomes.at(-1)?.outcome).toBe(outcome);
        }),
        { discard: true }
      );

      expect(descriptors).toHaveLength(3);
      expect(outcomes).toHaveLength(3);
      expect(descriptors).toEqual(
        Array.from({ length: 3 }, () => ({
          component: "api",
          operation: CanonicalOperationId.make("transactions.listTransactions"),
          trigger: "api",
          spanOperation: "fidy.operation",
          workKind: "canonical_operation",
          metadata: SpanMetadata.None(),
        }))
      );
    })
);

it.effect("nests model work beneath a hosted Turn and preserves provider failure identity", () =>
  Effect.gen(function* () {
    const parents: string[] = [];
    let nextSpan = 1;
    const failure = FailureReason.ProviderUnavailable();

    const telemetry = makeTelemetryService({
      ...DisabledTelemetryResource.adapter,
      startSpan: (_descriptor, parent) =>
        Effect.sync(() => {
          parents.push(
            Option.match(parent, { onNone: () => "root", onSome: (value) => value.parentSpanId })
          );

          return Option.some({
            traceId: TelemetryTraceId.make("1".repeat(32)),
            spanId: TelemetrySpanId.make(String(nextSpan++).padStart(16, "0")),
            sampled: true,
            state: undefined,
          });
        }),
    });

    const exit = yield* observeHostedResponse(
      observeApplicationOperation(Effect.fail(failure), {
        component: "agent",
        operation: "agent.modelRound",
        trigger: "api",
        spanOperation: "agent.model",
        workKind: "model_round",
        metadata: SpanMetadata.None(),
      }),
      { trigger: "api", parent: Option.none(), release: "unknown" }
    ).pipe(Effect.provideService(Telemetry, telemetry), Effect.exit);

    expect(exit).toEqual(Exit.fail(failure));
    expect(parents).toEqual(["root", "0000000000000001"]);
  })
);

it.effect("keeps standalone fixture work usable without installing telemetry", () =>
  Effect.gen(function* () {
    const response = new Response(null, { status: 503 });
    expect(
      yield* observeCanonicalResponse(
        Effect.succeed(response),
        CanonicalOperationId.make("transactions.listTransactions")
      )
    ).toBe(response);
  })
);

it.effect(
  "distinguishes hosted model output rejection, resource limits and provider outage without recording their details",
  () =>
    Effect.gen(function* () {
      const outcomes: DeclaredOutcome[] = [];

      const telemetry = makeTelemetryService({
        ...DisabledTelemetryResource.adapter,
        startSpan: () =>
          Effect.succeedSome({
            traceId: TelemetryTraceId.make("1".repeat(32)),
            spanId: TelemetrySpanId.make("2".repeat(16)),
            sampled: true,
            state: undefined,
          }),
        recordOutcome: (_span, outcome) =>
          Effect.sync(() => {
            outcomes.push(outcome);
          }),
      });

      const failures = [
        new HostedInferenceError({
          reason: FailureReason.ProviderQuotaExceeded(),
          retryable: false,
          retryAfter: Option.none(),
        }),
        new HostedInferenceError({
          reason: FailureReason.ProviderUnavailable(),
          retryable: true,
          retryAfter: Option.none(),
        }),
        new HostedInferenceError({
          reason: FailureReason.CapacityExceeded({ inputTokens: 765_432 }),
          retryable: false,
          retryAfter: Option.none(),
        }),
        new HostedInferenceError({
          reason: FailureReason.InvalidOutput({
            description: "Hosted tool arguments were invalid",
          }),
          retryable: false,
          retryAfter: Option.none(),
        }),
        new HostedInferenceError({
          reason: FailureReason.InvalidOutput({
            description: "Hosted provider response was invalid",
          }),
          retryable: false,
          retryAfter: Option.none(),
        }),
        new HostedInferenceError({
          reason: FailureReason.StructuredOutputExceeded(),
          retryable: false,
          retryAfter: Option.none(),
        }),
      ];

      yield* Effect.forEach(
        failures,
        Effect.fnUntraced(function* (failure) {
          assert.deepStrictEqual(
            yield* observeApplicationOperation(Effect.fail(failure), {
              component: "agent",
              operation: "agent.modelRound",
              trigger: "api",
              spanOperation: "agent.model",
              workKind: "model_round",
              metadata: SpanMetadata.None(),
            }).pipe(Effect.provideService(Telemetry, telemetry), Effect.exit),
            Exit.fail(failure)
          );
        }),
        { discard: true }
      );

      expect(outcomes).toEqual([
        {
          outcome: "failed",
          error: Option.some("model_provider_quota_exceeded"),
          retryable: false,
        },
        { outcome: "failed", error: Option.some("model_unavailable"), retryable: true },
        { outcome: "failed", error: Option.some("capacity_exceeded"), retryable: false },
        {
          outcome: "rejected",
          error: Option.some("model_tool_arguments_rejected"),
          retryable: false,
        },
        {
          outcome: "rejected",
          error: Option.some("model_provider_response_rejected"),
          retryable: false,
        },
        { outcome: "rejected", error: Option.some("model_response_rejected"), retryable: false },
      ]);
    })
);
