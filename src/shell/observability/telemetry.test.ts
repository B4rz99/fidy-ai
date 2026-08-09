import { expect, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Layer, Option } from "effect";
import { makeSpanDescriptor } from "~/shell/testing/telemetry-fixtures";
import { TelemetryDisabled } from "./disabled";
import { TelemetrySpanId, TelemetryTraceId } from "./protocol";
import { Telemetry, type TelemetryAdapter, type TelemetrySpan } from "./telemetry";

const telemetryLayer = (adapter: TelemetryAdapter): Layer.Layer<Telemetry> =>
  Telemetry.layer(Effect.succeed({ adapter, close: Effect.void }));

const descriptor = makeSpanDescriptor();

const unobservedAdapter: TelemetryAdapter = {
  startSpan: () => Effect.succeed(Option.none()),
  finishSpan: () => Effect.void,
  recordOutcome: () => Effect.void,
  captureFailure: () => Effect.void,
  addBreadcrumb: () => Effect.void,
};

const makeTelemetryAdapter = (overrides: Partial<TelemetryAdapter> = {}): TelemetryAdapter => ({
  ...unobservedAdapter,
  ...overrides,
});

it.effect("disabled telemetry preserves every application outcome without observing work", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryDisabled);
    const telemetry = Context.get(services, Telemetry);
    const success = yield* telemetry.span(descriptor, Effect.succeed("completed"));
    const failure = yield* Effect.exit(telemetry.span(descriptor, Effect.fail("declined")));
    const defect = yield* Effect.exit(telemetry.span(descriptor, Effect.die("defect-sentinel")));
    const continued = yield* telemetry.continueSpan(
      { version: 1, traceId: "1".repeat(32), parentSpanId: "2".repeat(16) },
      descriptor,
      Effect.succeed("continued")
    );
    yield* telemetry.recordOutcome({
      outcome: "succeeded",
      error: Option.none(),
      retryable: false,
    });
    yield* telemetry.addBreadcrumb({
      category: "agent",
      action: "model_started",
      component: "agent",
      outcome: Option.none(),
      error: Option.none(),
      attempt: Option.none(),
      durationMilliseconds: Option.none(),
    });
    yield* telemetry.captureFailure({
      _tag: "Defect",
      component: "agent",
      operation: "agent.hostedTurn",
      error: "unexpected_defect",
      cause: new Error("disabled-defect-sentinel"),
    });

    expect(success).toBe("completed");
    expect(continued).toBe("continued");
    expect(
      Exit.isFailure(failure) && Option.getOrNull(Exit.findErrorOption(failure)) === "declined"
    ).toBe(true);
    expect(Exit.isFailure(defect) && Cause.hasDies(defect.cause)).toBe(true);
    expect(yield* telemetry.captureDurableContext).toEqual(Option.none());
  })
);

it.effect("a synchronous start defect runs application work unobserved", () =>
  Effect.gen(function* () {
    const adapter = makeTelemetryAdapter({
      startSpan: () => {
        throw new Error("synchronous-start-sentinel");
      },
    });

    const services = yield* Layer.build(telemetryLayer(adapter));
    const result = yield* Context.get(services, Telemetry).span(
      makeSpanDescriptor(),
      Effect.succeed("application-result")
    );

    expect(result).toBe("application-result");
  })
);

it.effect("an unobserved root clears ambient context from its nested work", () =>
  Effect.gen(function* () {
    const parents: Array<Parameters<TelemetryAdapter["startSpan"]>[1]> = [];
    const adapter = makeTelemetryAdapter({
      startSpan: (_descriptor, parent) => {
        parents.push(parent);
        const index = parents.length;
        return Effect.succeed(
          index === 2
            ? Option.none()
            : Option.some({
                traceId: TelemetryTraceId.make(String(index).repeat(32)),
                spanId: TelemetrySpanId.make(String(index).repeat(16)),
                sampled: true,
                state: {},
              })
        );
      },
    });
    const services = yield* Layer.build(telemetryLayer(adapter));
    const telemetry = Context.get(services, Telemetry);

    yield* telemetry.span(
      descriptor,
      telemetry.rootSpan(descriptor, telemetry.span(descriptor, Effect.void))
    );

    expect(parents).toHaveLength(3);
    expect(parents.every(Option.isNone)).toBe(true);
  })
);

it.effect("a malformed adapter span runs nested application work unobserved", () =>
  Effect.gen(function* () {
    const hostileSpan: TelemetrySpan = {
      get traceId(): TelemetrySpan["traceId"] {
        throw new Error("trace-getter-sentinel");
      },
      get spanId(): TelemetrySpan["spanId"] {
        throw new Error("span-getter-sentinel");
      },
      sampled: true,
      state: {},
    };
    const adapter = makeTelemetryAdapter({
      startSpan: () => Effect.succeed(Option.some(hostileSpan)),
    });
    const services = yield* Layer.build(telemetryLayer(adapter));
    const telemetry = Context.get(services, Telemetry);
    const result = yield* telemetry.span(
      descriptor,
      telemetry.span(descriptor, Effect.succeed("application-result"))
    );

    expect(result).toBe("application-result");
    expect(yield* telemetry.captureDurableContext).toEqual(Option.none());
  })
);

it.effect("synchronous adapter defects never alter work or escape observation methods", () =>
  Effect.gen(function* () {
    const adapter = makeTelemetryAdapter({
      startSpan: () =>
        Effect.succeed(
          Option.some({
            traceId: TelemetryTraceId.make("1".repeat(32)),
            spanId: TelemetrySpanId.make("2".repeat(16)),
            sampled: true,
            state: {},
          })
        ),
      finishSpan: () => {
        throw new Error("finish-adapter-sentinel");
      },
      recordOutcome: () => {
        throw new Error("outcome-adapter-sentinel");
      },
      captureFailure: () => {
        throw new Error("failure-adapter-sentinel");
      },
      addBreadcrumb: () => {
        throw new Error("breadcrumb-adapter-sentinel");
      },
    });
    const services = yield* Layer.build(telemetryLayer(adapter));
    const telemetry = Context.get(services, Telemetry);
    const failure = yield* Effect.exit(
      telemetry.span(
        descriptor,
        Effect.gen(function* () {
          yield* telemetry.recordOutcome({
            outcome: "succeeded",
            error: Option.none(),
            retryable: false,
          });
          yield* telemetry.addBreadcrumb({
            category: "agent",
            action: "model_started",
            component: "agent",
            outcome: Option.none(),
            error: Option.none(),
            attempt: Option.none(),
            durationMilliseconds: Option.none(),
          });
          yield* telemetry.captureFailure({
            _tag: "Defect",
            component: "agent",
            operation: "agent.hostedTurn",
            error: "unexpected_defect",
            cause: new Error("application-defect-sentinel"),
          });
          return yield* Effect.fail("application-failure");
        })
      )
    );

    expect(
      Exit.isFailure(failure) &&
        Option.getOrNull(Exit.findErrorOption(failure)) === "application-failure"
    ).toBe(true);
  })
);
