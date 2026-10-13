import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Option, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import {
  type DeclaredOutcome,
  type SpanDescriptor,
  type TelemetryAdapter,
  type TelemetryService,
  TelemetrySpanId,
  TelemetryTraceId,
} from "~/shell/observability/contract";
import { Telemetry, makeTelemetryService } from "~/shell/observability/operations";
import { makeProviderTransport } from "./transport";

const makeRecorder = (): Readonly<{
  adapter: TelemetryAdapter;
  descriptors: SpanDescriptor[];
  outcomes: DeclaredOutcome[];
  statuses: number[];
  telemetry: TelemetryService;
}> => {
  const descriptors: SpanDescriptor[] = [];
  const outcomes: DeclaredOutcome[] = [];
  const statuses: number[] = [];
  const adapter: TelemetryAdapter = {
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
    finishSpan: () => Effect.void,
    recordOutcome: (_span, outcome) =>
      Effect.sync(() => {
        outcomes.push(outcome);
      }),
    recordResponseStatus: (_span, status) =>
      Effect.sync(() => {
        statuses.push(status);
      }),
    captureFailure: () => Effect.void,
    addBreadcrumb: () => Effect.void,
    recordModelUsage: () => Effect.void,
    exportWork: () => undefined,
  };
  return { adapter, descriptors, outcomes, statuses, telemetry: makeTelemetryService(adapter) };
};

it.effect(
  "observes every closed provider with metadata only and suppresses external trace headers",
  () =>
    Effect.gen(function* () {
      const recorder = makeRecorder();
      const credential = "credential-query-body-header-sentinel";
      const client = HttpClient.make((request) => {
        expect(request.headers.traceparent).toBeUndefined();
        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response(credential)));
      });
      for (const provider of [
        "github",
        "google",
        "microsoft",
        "cloudflare-access",
        "kapso",
        "resend",
        "wompi",
      ] as const) {
        const request = HttpClientRequest.get(
          `https://provider.example/${credential}?code=${credential}`
        ).pipe(HttpClientRequest.setHeader("authorization", `Bearer ${credential}`));
        const result = yield* makeProviderTransport(provider)(client)
          .execute(request, 128)
          .pipe(Effect.provideService(Telemetry, recorder.telemetry));
        expect(new TextDecoder().decode(result.body)).toBe(credential);
      }
      expect(recorder.descriptors).toHaveLength(7);
      expect(recorder.statuses).toEqual([200, 200, 200, 200, 200, 200, 200]);
      expect(recorder.outcomes.every((outcome) => outcome.outcome === "succeeded")).toBe(true);
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
        descriptors: recorder.descriptors,
        outcomes: recorder.outcomes,
        statuses: recorder.statuses,
      });
      expect(encoded).not.toContain(credential);
      expect(encoded).not.toContain("provider.example");
    })
);

it.effect("classifies failed provider statuses and oversized bodies while preserving results", () =>
  Effect.gen(function* () {
    const recorder = makeRecorder();
    for (const scenario of [
      { status: 403, body: "{}", bound: 64, outcome: "rejected" },
      { status: 503, body: "{}", bound: 64, outcome: "failed" },
      { status: 200, body: "too-large-body-sentinel", bound: 2, outcome: "failed" },
    ]) {
      const client = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(scenario.body, { status: scenario.status })
          )
        )
      );
      const result = yield* Effect.exit(
        makeProviderTransport("google")(client)
          .execute(HttpClientRequest.get("https://provider.example"), scenario.bound)
          .pipe(Effect.provideService(Telemetry, recorder.telemetry))
      );
      expect(Exit.isSuccess(result)).toBe(scenario.status !== 200);
      expect(recorder.outcomes.at(-1)?.outcome).toBe(scenario.outcome);
    }
    expect(recorder.statuses).toEqual([403, 503, 200]);
    expect(recorder.outcomes.at(-1)?.error).toEqual(Option.some("capacity_exceeded"));
  })
);

it.effect("preserves cancellation and contains broken telemetry exporters", () =>
  Effect.gen(function* () {
    const recorder = makeRecorder();
    const started = Promise.withResolvers<void>();
    const pendingClient = HttpClient.make(() =>
      Effect.sync(() => started.resolve()).pipe(Effect.andThen(Effect.never))
    );
    const fiber = yield* makeProviderTransport("microsoft")(pendingClient)
      .execute(HttpClientRequest.get("https://provider.example"), 64)
      .pipe(
        Effect.provideService(Telemetry, recorder.telemetry),
        Effect.forkChild({ startImmediately: true })
      );
    yield* Effect.tryPromise(() => started.promise);
    yield* Fiber.interrupt(fiber);
    const interrupted = yield* Fiber.await(fiber);
    expect(Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause)).toBe(true);
    expect(recorder.outcomes.at(-1)?.outcome).toBe("interrupted");
    const broken = makeTelemetryService({
      ...recorder.adapter,
      recordOutcome: () => Effect.die("sink-secret-sentinel"),
      finishSpan: () => Effect.die("sink-secret-sentinel"),
    });
    const client = HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response("ok")))
    );
    const result = yield* makeProviderTransport("cloudflare-access")(client)
      .execute(HttpClientRequest.get("https://provider.example"), 64)
      .pipe(Effect.provideService(Telemetry, broken));
    expect(new TextDecoder().decode(result.body)).toBe("ok");
  })
);
