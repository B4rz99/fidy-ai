import { expect, it } from "@effect/vitest";
import { Data, Effect, Exit, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";
import { closeTelemetryClient, makeSentryTelemetry, projectSdkSpan } from "./sentry-adapter";
import type { NonProductionTelemetryConfig } from "./telemetry-config";

class TestTransportFailure extends Data.TaggedError("TestTransportFailure") {}

const enabledConfig = {
  _tag: "NonProductionEnabled",
  environment: "local",
  project: "non-production",
  capture: { errors: true, traces: true },
  dsn: "https://public@example.invalid/1",
  release: "fidy@0123456789abcdef0123456789abcdef01234567",
  errorSampleRate: 1,
  rootTraceRate: 1,
} satisfies NonProductionTelemetryConfig;

it.effect("pins collection policy and fails malformed final hooks closed", () =>
  Effect.gen(function* () {
    const telemetry = yield* Effect.acquireRelease(
      Effect.sync(() => makeSentryTelemetry(enabledConfig)),
      ({ resource }) => resource.close
    );
    const options = telemetry.client.getOptions();
    const beforeSendSpan = Option.getOrThrow(Option.fromNullishOr(options.beforeSendSpan));
    const beforeBreadcrumb = Option.getOrThrow(Option.fromNullishOr(options.beforeBreadcrumb));
    const beforeSendLog = Option.getOrThrow(Option.fromNullishOr(options.beforeSendLog));
    const beforeSendMetric = Option.getOrThrow(Option.fromNullishOr(options.beforeSendMetric));

    expect(options.integrations).toEqual([]);
    expect(options.sendDefaultPii).toBe(false);
    expect(options.attachStacktrace).toBe(false);
    expect(options.maxBreadcrumbs).toBe(0);
    expect(options.sendClientReports).toBe(false);
    expect(options.tracePropagationTargets).toEqual([]);
    expect(options.enableLogs).toBe(false);
    expect(options.enableMetrics).toBe(false);
    expect(options.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpHeaders: { request: false, response: false },
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      stackFrameVariables: false,
      frameContextLines: 0,
    });
    const emptySpan = { data: {}, span_id: "", start_timestamp: 0, trace_id: "" };
    expect(projectSdkSpan({})).toEqual(emptySpan);
    expect(projectSdkSpan(null)).toEqual(emptySpan);
    expect(beforeBreadcrumb({})).toBeNull();
    expect(beforeSendLog({ level: "info", message: "sentinel" })).toBeNull();
    expect(beforeSendMetric({ name: "sentinel", value: 1, type: "counter" })).toBeNull();
    expect(beforeSendSpan(emptySpan)).toEqual(emptySpan);
  })
);

it.effect("bounds a hanging client flush without failing shutdown", () =>
  Effect.gen(function* () {
    const close = yield* Effect.forkChild(closeTelemetryClient(() => Effect.never));

    yield* TestClock.adjust("1 second");
    const exit = yield* Effect.exit(Fiber.join(close));

    expect(Exit.isSuccess(exit)).toBe(true);
  })
);

it.effect.each(["rejected", "unsuccessful"] as const)("contains $ client flushes", (outcome) =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      closeTelemetryClient(() =>
        outcome === "rejected" ? Effect.fail(new TestTransportFailure()) : Effect.succeed(false)
      )
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  })
);
