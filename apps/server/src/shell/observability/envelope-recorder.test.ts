import { expect, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Layer, Option, Ref, Schema } from "effect";
import { TestClock } from "effect/testing";
import {
  decodeEnvelopeItems,
  errorEnvelopePayloads as errorPayloads,
  transactionEnvelopePayloads as transactionPayloads,
} from "~/shell/testing/telemetry-envelope-fixtures";
import {
  type SpanWork,
  makeSpanDescriptor,
  makeWorkSpanDescriptor,
} from "~/shell/testing/telemetry-fixtures";
import { strictDecoding } from "./decoding";
import {
  EnvelopeRecorder,
  TelemetryEnvelopeRecording,
  telemetryEnvelopeRecording,
} from "./envelope-recorder";
import {
  ClassifiedFailure,
  type DurableTraceContext,
  SpanDescriptor,
  TelemetryAttempt,
  TelemetryBreadcrumb,
  TelemetryCount,
  TelemetryDuration,
  TelemetryHttpStatus,
} from "./protocol";
import { isSupportedEnvelopeItemType } from "./sentry-adapter";
import { Telemetry } from "./telemetry";

const descriptor = makeSpanDescriptor();

it.effect("records only reconstructed metadata in complete serialized envelopes", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryEnvelopeRecording);
    const telemetry = Context.get(services, Telemetry);
    const recorder = Context.get(services, EnvelopeRecorder);
    const hostileError = new Error("error-message-sentinel");
    hostileError.stack = [
      "Error: error-message-sentinel",
      "    at safeFunction (/workspace/src/shell/agent/agent-service.ts:12:4)",
      "    at urlSentinel (https://forbidden.example/user/financial-sentinel:9:2)",
      "    at urlSourceSentinel (https://forbidden.example/src/url-source-sentinel.ts:9:2)",
      "    at traversalSentinel (/workspace/src/../../traversal-sentinel.ts:9:2)",
    ].join("\n");

    yield* telemetry.span(
      descriptor,
      Effect.gen(function* () {
        yield* telemetry.addBreadcrumb({
          category: "agent",
          action: "model_started",
          component: "agent",
          outcome: Option.none(),
          error: Option.none(),
          attempt: Option.none(),
          durationMilliseconds: Option.none(),
        });
        yield* telemetry.recordOutcome({
          outcome: "rejected",
          error: Option.some("model_unavailable"),
          retryable: false,
        });
        yield* telemetry.captureFailure({
          _tag: "Defect",
          component: "agent",
          operation: "agent.hostedTurn",
          error: "unexpected_defect",
          cause: hostileError,
        });
      })
    );

    const envelopes = yield* recorder.serializedEnvelopes;
    const serialized = envelopes.map((bytes) => new TextDecoder().decode(bytes)).join("\n");
    const items = envelopes.flatMap(decodeEnvelopeItems);
    const itemTypes = items.flatMap(({ header }) =>
      typeof header === "object" && header !== null && "type" in header ? [header.type] : []
    );

    expect(itemTypes).toContain("event");
    expect(itemTypes).toContain("transaction");
    expect(serialized).toContain("Unexpected defect");
    expect(serialized).toContain("model_started");
    expect(serialized).toContain("src/shell/agent/agent-service.ts");
    expect(serialized).not.toContain("error-message-sentinel");
    expect(serialized).not.toContain("forbidden.example");
    expect(serialized).not.toContain("financial-sentinel");
    expect(serialized).not.toContain("url-source-sentinel");
    expect(serialized).not.toContain("traversal-sentinel");
    expect(serialized).not.toContain('"request"');
    expect(serialized).not.toContain('"user"');
  })
);

it.effect("drops every forbidden sentinel and malformed telemetry channel", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryEnvelopeRecording);
    const telemetry = Context.get(services, Telemetry);
    const recorder = Context.get(services, EnvelopeRecorder);
    const hostileCause = Object.assign(new Error("error-message-sentinel"), {
      request: "request-sentinel",
      canonicalInput: "canonical-input-sentinel",
      canonicalOutput: "canonical-output-sentinel",
      databaseRow: "database-sentinel",
      sql: "sql-table-sentinel",
      modelPrompt: "agent-model-sentinel",
      providerEvidence: "provider-sentinel",
      queuePayload: "queue-sentinel",
      arbitraryContext: "arbitrary-context-sentinel",
      user: "user-hashed-identity-sentinel",
      attachment: "attachment-sentinel",
      url: "https://raw-url-sentinel.example/path",
      ip: "203.0.113.99",
      geo: "geo-sentinel",
      device: "device-sentinel",
      payloadSize: "payload-size-sentinel",
      rowCount: "row-count-sentinel",
      locals: "locals-sentinel",
      sourceContext: "source-context-sentinel",
    });
    hostileCause.stack = "Error: error-message-sentinel";

    yield* telemetry.span(
      descriptor,
      Effect.gen(function* () {
        expect(
          Option.isNone(
            Schema.decodeUnknownOption(
              TelemetryBreadcrumb,
              strictDecoding
            )({
              category: "agent",
              action: "model_started",
              component: "agent",
              outcome: Option.none(),
              error: Option.none(),
              attempt: Option.none(),
              durationMilliseconds: Option.none(),
              data: "breadcrumb-sentinel",
            })
          )
        ).toBe(true);
        yield* telemetry.captureFailure({
          _tag: "Defect",
          component: "agent",
          operation: "agent.hostedTurn",
          error: "unexpected_defect",
          cause: hostileCause,
        });
      })
    );
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(
          SpanDescriptor,
          strictDecoding
        )({
          ...descriptor,
          request: "span-request-sentinel",
        })
      )
    ).toBe(true);
    expect(
      Option.isNone(
        Schema.decodeUnknownOption(
          ClassifiedFailure,
          strictDecoding
        )({
          _tag: "Defect",
          component: "agent",
          operation: "agent.hostedTurn",
          error: "unknown-error-sentinel",
          cause: hostileCause,
        })
      )
    ).toBe(true);

    const envelopes = yield* recorder.serializedEnvelopes;
    const serialized = envelopes.map((bytes) => new TextDecoder().decode(bytes)).join("\n");
    expect(envelopes).toHaveLength(2);
    for (const sentinel of [
      "error-message-sentinel",
      "request-sentinel",
      "canonical-input-sentinel",
      "canonical-output-sentinel",
      "database-sentinel",
      "sql-table-sentinel",
      "agent-model-sentinel",
      "provider-sentinel",
      "queue-sentinel",
      "arbitrary-context-sentinel",
      "user-hashed-identity-sentinel",
      "attachment-sentinel",
      "raw-url-sentinel",
      "203.0.113.99",
      "geo-sentinel",
      "device-sentinel",
      "payload-size-sentinel",
      "row-count-sentinel",
      "locals-sentinel",
      "source-context-sentinel",
      "breadcrumb-sentinel",
      "span-request-sentinel",
      "unknown-error-sentinel",
    ]) {
      expect(serialized).not.toContain(sentinel);
    }
    for (const forbiddenField of [
      '"request"',
      '"user"',
      '"extra"',
      '"attachments"',
      '"server_name"',
      '"modules"',
      '"device"',
      '"ip_address"',
    ]) {
      expect(serialized).not.toContain(forbiddenField);
    }
  })
);

it.effect("derives a failed status without serializing the application error", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryEnvelopeRecording);
    const telemetry = Context.get(services, Telemetry);
    const recorder = Context.get(services, EnvelopeRecorder);

    const exit = yield* Effect.exit(
      telemetry.span(descriptor, Effect.fail("application-error-sentinel"))
    );
    expect(Exit.isFailure(exit)).toBe(true);

    const transactions = transactionPayloads(yield* recorder.serializedEnvelopes);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.contexts.trace.status).toBe("internal_error");
    const serialized = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(transactions);
    expect(serialized).not.toContain("application-error-sentinel");
  })
);

it.effect("contains a projector defect and drops only that telemetry", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryEnvelopeRecording);
    const telemetry = Context.get(services, Telemetry);
    const recorder = Context.get(services, EnvelopeRecorder);
    const hostileCause = new Error("projector-defect-message-sentinel");
    Object.defineProperty(hostileCause, "stack", {
      get: () => {
        throw new Error("projector-defect-sentinel");
      },
    });

    const result = yield* telemetry.span(
      descriptor,
      Effect.as(
        telemetry.captureFailure({
          _tag: "Defect",
          component: "agent",
          operation: "agent.hostedTurn",
          error: "unexpected_defect",
          cause: hostileCause,
        }),
        "application-result"
      )
    );

    expect(result).toBe("application-result");
    const envelopes = yield* recorder.serializedEnvelopes;
    expect(transactionPayloads(envelopes)).toHaveLength(1);
    const serialized = envelopes.map((bytes) => new TextDecoder().decode(bytes)).join("\n");
    expect(serialized).not.toContain("projector-defect");
  })
);

it("accepts only error and transaction envelope item types", () => {
  expect(isSupportedEnvelopeItemType("event")).toBe(true);
  expect(isSupportedEnvelopeItemType("transaction")).toBe(true);
  expect(isSupportedEnvelopeItemType("attachment")).toBe(false);
  expect(isSupportedEnvelopeItemType("profile")).toBe(false);
  expect(isSupportedEnvelopeItemType({ type: "event", payload: "unsupported-item-sentinel" })).toBe(
    false
  );
});

it.effect("continues fresh durable context and rejects malformed context into a safe root", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryEnvelopeRecording);
    const telemetry = Context.get(services, Telemetry);
    const recorder = Context.get(services, EnvelopeRecorder);
    const captured = yield* Ref.make<Option.Option<DurableTraceContext>>(Option.none());

    yield* telemetry.span(
      descriptor,
      Effect.flatMap(telemetry.captureDurableContext, (context) => Ref.set(captured, context))
    );
    const context = Option.getOrThrow(yield* Ref.get(captured));
    yield* telemetry.continueSpan(context, descriptor, Effect.void);
    yield* telemetry.continueSpan(
      { ...context, unknown: "context-sentinel" },
      descriptor,
      Effect.void
    );
    yield* TestClock.adjust("25 hours");
    yield* telemetry.continueSpan(context, descriptor, Effect.void);
    const hostileContext = Object.defineProperty({}, "version", {
      get: () => {
        throw new Error("context-getter-sentinel");
      },
    });
    const hostileResult = yield* telemetry.continueSpan(
      hostileContext,
      descriptor,
      Effect.succeed("application-result")
    );
    expect(hostileResult).toBe("application-result");

    const transactions = transactionPayloads(yield* recorder.serializedEnvelopes);
    expect(transactions).toHaveLength(5);
    expect(transactions[1]?.contexts.trace.trace_id).toBe(context.traceId);
    expect(transactions[1]?.contexts.trace.parent_span_id).toBe(context.parentSpanId);
    expect(transactions[2]?.contexts.trace.trace_id).not.toBe(context.traceId);
    expect(transactions[3]?.contexts.trace.trace_id).not.toBe(context.traceId);
    expect(transactions[4]?.contexts.trace.trace_id).not.toBe(context.traceId);
    const serializedTransactions = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(
      transactions
    );
    expect(serializedTransactions).not.toContain("context-sentinel");
    expect(serializedTransactions).not.toContain("context-getter-sentinel");
  })
);

const workAttributes = [
  {
    work: {
      workKind: "http_request",
      metadata: {
        _tag: "Http",
        method: "POST",
        route: "/transactions",
        status: Option.some(TelemetryHttpStatus.make(201)),
      },
    },
    attributes: {
      "http.request.method": "POST",
      "http.route": "/transactions",
      "http.response.status_code": 201,
    },
  },
  {
    work: {
      workKind: "http_request",
      metadata: {
        _tag: "Http",
        method: "GET",
        route: "/transactions",
        status: Option.none(),
      },
    },
    attributes: { "http.request.method": "GET", "http.route": "/transactions" },
  },
  {
    work: {
      workKind: "queue_attempt",
      metadata: {
        _tag: "Queue",
        attempt: TelemetryAttempt.make(2),
        inputCount: TelemetryCount.make(7),
        delayMilliseconds: TelemetryDuration.make(1_500),
      },
    },
    attributes: {
      "fidy.attempt": 2,
      "fidy.input_count": 7,
      "fidy.delay_milliseconds": 1_500,
    },
  },
  {
    work: {
      workKind: "provider_call",
      metadata: {
        _tag: "Provider",
        provider: "kapso",
        attempt: TelemetryAttempt.make(1),
        status: Option.some(TelemetryHttpStatus.make(503)),
      },
    },
    attributes: {
      "fidy.provider": "kapso",
      "fidy.attempt": 1,
      "http.response.status_code": 503,
    },
  },
  {
    work: {
      workKind: "provider_call",
      metadata: {
        _tag: "Provider",
        provider: "openai",
        attempt: TelemetryAttempt.make(3),
        status: Option.none(),
      },
    },
    attributes: { "fidy.provider": "openai", "fidy.attempt": 3 },
  },
  {
    work: {
      workKind: "model_call",
      metadata: {
        _tag: "Model",
        model: "gpt_5_6_luna",
      },
    },
    attributes: {
      "gen_ai.request.model": "gpt_5_6_luna",
      "fidy.attempt": 1,
      "fidy.duration_milliseconds": 0,
      "gen_ai.usage.input_tokens": 120,
      "gen_ai.usage.output_tokens": 45,
    },
  },
  {
    work: {
      workKind: "scheduled_execution",
      metadata: { _tag: "Schedule", attempt: TelemetryAttempt.make(4) },
    },
    attributes: { "fidy.attempt": 4 },
  },
] satisfies ReadonlyArray<{
  readonly work: SpanWork;
  readonly attributes: Readonly<Record<string, number | string>>;
}>;

it.effect("projects only the bounded attributes its own work kind admits", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryEnvelopeRecording);
    const telemetry = Context.get(services, Telemetry);
    const recorder = Context.get(services, EnvelopeRecorder);

    for (const { work } of workAttributes) {
      yield* telemetry.span(
        makeWorkSpanDescriptor(work),
        work.metadata._tag === "Model"
          ? telemetry.recordModelUsage({
              attempt: TelemetryAttempt.make(1),
              inputTokens: TelemetryCount.make(120),
              outputTokens: TelemetryCount.make(45),
            })
          : Effect.void
      );
    }

    const transactions = transactionPayloads(yield* recorder.serializedEnvelopes);
    expect(transactions.map((transaction) => transaction.contexts.trace.data)).toEqual(
      workAttributes.map(({ work, attributes }) => ({
        "fidy.component": "agent",
        "fidy.operation": "agent.hostedTurn",
        "fidy.trigger": "api",
        "fidy.work_kind": work.workKind,
        "fidy.outcome": "succeeded",
        "fidy.retryable": false,
        ...(work.workKind === "scheduled_execution" ? { "fidy.duration_milliseconds": 0 } : {}),
        ...attributes,
      }))
    );
  })
);

it.effect("records a response status learned while provider work is active", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryEnvelopeRecording);
    const telemetry = Context.get(services, Telemetry);
    const recorder = Context.get(services, EnvelopeRecorder);
    const provider = makeWorkSpanDescriptor({
      workKind: "provider_call",
      metadata: {
        _tag: "Provider",
        provider: "kapso",
        attempt: TelemetryAttempt.make(2),
        status: Option.none(),
      },
    });

    yield* telemetry.span(provider, telemetry.recordResponseStatus(TelemetryHttpStatus.make(202)));

    const transactions = transactionPayloads(yield* recorder.serializedEnvelopes);
    expect(transactions[0]?.contexts.trace.data).toMatchObject({
      "fidy.attempt": 2,
      "http.response.status_code": 202,
    });
  })
);

it.effect("reads a cancelled status from interruption and keeps a declared retryable failure", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryEnvelopeRecording);
    const telemetry = Context.get(services, Telemetry);
    const recorder = Context.get(services, EnvelopeRecorder);

    const interrupted = yield* Effect.exit(telemetry.span(descriptor, Effect.interrupt));
    yield* telemetry.span(
      descriptor,
      telemetry.recordOutcome({
        outcome: "failed",
        error: Option.some("provider_unavailable"),
        retryable: true,
      })
    );

    expect(Exit.isFailure(interrupted) && Cause.hasInterrupts(interrupted.cause)).toBe(true);
    const transactions = transactionPayloads(yield* recorder.serializedEnvelopes);
    expect(transactions.map((transaction) => transaction.contexts.trace.status)).toEqual([
      "cancelled",
      "internal_error",
    ]);
    expect(transactions[1]?.tags).toMatchObject({
      retryable: "true",
      error: "provider_unavailable",
    });
  })
);

it.effect("attaches an exhausted operational failure to its provider and its active span", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryEnvelopeRecording);
    const telemetry = Context.get(services, Telemetry);
    const recorder = Context.get(services, EnvelopeRecorder);
    const failure: ClassifiedFailure = {
      _tag: "ExhaustedOperationalFailure",
      component: "kapso",
      operation: "whatsapp.sendText",
      error: "provider_unavailable",
      provider: Option.some("kapso"),
      retryable: true,
      cause: new Error("operational-message-sentinel"),
    };

    yield* telemetry.span(descriptor, telemetry.captureFailure(failure));
    yield* telemetry.span(
      descriptor,
      telemetry.span(descriptor, telemetry.captureFailure(failure))
    );

    const events = errorPayloads(yield* recorder.serializedEnvelopes);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(event.tags).toEqual({
        component: "kapso",
        operation: "whatsapp.sendText",
        error: "provider_unavailable",
        retryable: "true",
        provider: "kapso",
      });
      expect(event.exception.values[0].type).toBe("FidyOperationalFailure");
      expect(event.exception.values[0].value).toBe("Exhausted operational failure");
      expect(event.contexts?.trace.op).toBe("agent.turn");
    }
    expect(events[0]?.contexts?.trace.parent_span_id).toBeUndefined();
    expect(events[1]?.contexts?.trace.parent_span_id).toEqual(expect.any(String));
    const serialized = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(events);
    expect(serialized).not.toContain("operational-message-sentinel");
  })
);

it.effect(
  "reports a failure captured with no span in scope, under trace coordinates naming no op",
  () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(TelemetryEnvelopeRecording);
      const telemetry = Context.get(services, Telemetry);
      const recorder = Context.get(services, EnvelopeRecorder);
      const failure: ClassifiedFailure = {
        _tag: "Defect",
        component: "agent",
        operation: "agent.hostedTurn",
        error: "unexpected_defect",
        cause: new Error("unspanned-message-sentinel"),
      };

      yield* telemetry.captureFailure(failure);

      const envelopes = yield* recorder.serializedEnvelopes;
      const events = errorPayloads(envelopes);
      expect(events).toHaveLength(1);
      expect(transactionPayloads(envelopes)).toHaveLength(0);
      expect(events[0]?.tags).toEqual({
        component: "agent",
        operation: "agent.hostedTurn",
        error: "unexpected_defect",
        retryable: "false",
      });
      expect(events[0]?.contexts?.trace.trace_id).toEqual(expect.any(String));
      expect(events[0]?.contexts?.trace.span_id).toEqual(expect.any(String));
      expect(events[0]?.contexts?.trace.op).toBeUndefined();
      const serialized = new TextDecoder().decode(envelopes[0]);
      expect(serialized).not.toContain("unspanned-message-sentinel");
    })
);

it.effect("keeps only usable source coordinates and drops a cause carrying no stack", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryEnvelopeRecording);
    const telemetry = Context.get(services, Telemetry);
    const recorder = Context.get(services, EnvelopeRecorder);
    const hostileError = new Error("frame-message-sentinel");
    hostileError.stack = [
      "Error: frame-message-sentinel",
      "    at src/shell/agent/agent-service.ts:12:4",
      "    at extensionSentinel (/workspace/src/shell/agent/agent-service.txt:9:2)",
      "    at columnSentinel (/workspace/src/shell/agent/agent-service.ts:9:0)",
    ].join("\n");
    const defect = (cause: unknown): ClassifiedFailure => ({
      _tag: "Defect",
      component: "agent",
      operation: "agent.hostedTurn",
      error: "unexpected_defect",
      cause,
    });

    yield* telemetry.span(descriptor, telemetry.captureFailure(defect(hostileError)));
    yield* telemetry.span(descriptor, telemetry.captureFailure(defect("plain-cause-sentinel")));
    yield* telemetry.span(descriptor, telemetry.captureFailure(defect({ stack: 7 })));

    const events = errorPayloads(yield* recorder.serializedEnvelopes);
    expect(events[0]?.exception.values[0].stacktrace.frames).toEqual([
      {
        module: "src/shell/agent/agent-service",
        filename: "src/shell/agent/agent-service.ts",
        function: "anonymous",
        lineno: 12,
        colno: 4,
      },
    ]);
    expect(events[1]?.exception.values[0].stacktrace.frames).toEqual([]);
    expect(events[2]?.exception.values[0].stacktrace.frames).toEqual([]);
    const serialized = yield* Schema.encodeEffect(Schema.UnknownFromJsonString)(events);
    expect(serialized).not.toContain("extensionSentinel");
    expect(serialized).not.toContain("columnSentinel");
    expect(serialized).not.toContain("plain-cause-sentinel");
  })
);

it.effect("carries approved breadcrumbs on transactions but never on error events", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryEnvelopeRecording);
    const telemetry = Context.get(services, Telemetry);
    const recorder = Context.get(services, EnvelopeRecorder);

    yield* telemetry.span(
      descriptor,
      Effect.gen(function* () {
        yield* telemetry.addBreadcrumb({
          category: "provider",
          action: "provider_completed",
          component: "kapso",
          outcome: Option.some("failed"),
          error: Option.some("provider_unavailable"),
          attempt: Option.some(TelemetryAttempt.make(3)),
          durationMilliseconds: Option.some(TelemetryDuration.make(1_250)),
        });
        yield* telemetry.captureFailure({
          _tag: "Defect",
          component: "agent",
          operation: "agent.hostedTurn",
          error: "unexpected_defect",
          cause: Option.none(),
        });
      })
    );

    const envelopes = yield* recorder.serializedEnvelopes;
    const transactions = transactionPayloads(envelopes);
    expect(errorPayloads(envelopes)[0]).not.toHaveProperty("breadcrumbs");
    expect(transactions[0]?.breadcrumbs).toHaveLength(1);
    expect(transactions[0]?.breadcrumbs[0]).toMatchObject({
      category: "provider",
      message: "provider_completed",
      level: "info",
    });
    expect(transactions[0]?.breadcrumbs[0]?.data).toEqual({
      component: "kapso",
      outcome: "failed",
      error: "provider_unavailable",
      attempt: 3,
      duration_milliseconds: 1_250,
    });
  })
);

it.effect("gates errors and traces independently", () =>
  Effect.gen(function* () {
    const errorOnly = yield* Layer.build(
      telemetryEnvelopeRecording({ capture: { errors: true, traces: false } })
    );
    const errorTelemetry = Context.get(errorOnly, Telemetry);
    yield* errorTelemetry.span(
      descriptor,
      errorTelemetry.captureFailure({
        _tag: "Defect",
        component: "agent",
        operation: "agent.hostedTurn",
        error: "unexpected_defect",
        cause: new Error("error-only-sentinel"),
      })
    );
    const errorOnlyEnvelopes = yield* Context.get(errorOnly, EnvelopeRecorder).serializedEnvelopes;

    const traceOnly = yield* Layer.build(
      telemetryEnvelopeRecording({ capture: { errors: false, traces: true } })
    );
    const traceTelemetry = Context.get(traceOnly, Telemetry);
    yield* traceTelemetry.span(
      descriptor,
      traceTelemetry.captureFailure({
        _tag: "Defect",
        component: "agent",
        operation: "agent.hostedTurn",
        error: "unexpected_defect",
        cause: new Error("trace-only-sentinel"),
      })
    );
    const traceOnlyEnvelopes = yield* Context.get(traceOnly, EnvelopeRecorder).serializedEnvelopes;

    expect(errorPayloads(errorOnlyEnvelopes)).toHaveLength(1);
    expect(transactionPayloads(errorOnlyEnvelopes)).toHaveLength(0);
    expect(errorPayloads(traceOnlyEnvelopes)).toHaveLength(0);
    expect(transactionPayloads(traceOnlyEnvelopes)).toHaveLength(1);
  })
);

it.effect.each(["rate-limited", "failed"] as const)(
  "contains $ transport outcomes behind application work",
  (transportOutcome) =>
    Effect.gen(function* () {
      const services = yield* Layer.build(telemetryEnvelopeRecording({ transportOutcome }));
      const telemetry = Context.get(services, Telemetry);

      const result = yield* telemetry.span(descriptor, Effect.succeed("application-result"));
      yield* Context.get(services, EnvelopeRecorder).serializedEnvelopes;

      expect(result).toBe("application-result");
    })
);

it.effect("samples roots at the configured rate and keeps production errors at 100%", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      telemetryEnvelopeRecording({
        capture: { errors: true, traces: true },
        rootTraceRate: 0.1,
        randomUnitInterval: () => 0.1,
      })
    );
    const telemetry = Context.get(services, Telemetry);
    yield* telemetry.span(
      descriptor,
      telemetry.captureFailure({
        _tag: "Defect",
        component: "agent",
        operation: "agent.hostedTurn",
        error: "unexpected_defect",
        cause: new Error("unsampled-root-error"),
      })
    );
    const envelopes = yield* Context.get(services, EnvelopeRecorder).serializedEnvelopes;

    expect(transactionPayloads(envelopes)).toHaveLength(0);
    expect(errorPayloads(envelopes)).toHaveLength(1);
  })
);

it.effect("inherits an unsampled durable parent without resampling", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(
      telemetryEnvelopeRecording({
        capture: { errors: true, traces: true },
        rootTraceRate: 1,
        randomUnitInterval: () => 0,
      })
    );
    const telemetry = Context.get(services, Telemetry);
    yield* telemetry.continueSpan(
      {
        version: 1,
        traceId: "1".repeat(32),
        parentSpanId: "2".repeat(16),
        sampled: false,
        capturedAtUnixMilliseconds: 0,
      },
      descriptor,
      Effect.void
    );

    expect(
      transactionPayloads(yield* Context.get(services, EnvelopeRecorder).serializedEnvelopes)
    ).toHaveLength(0);
  })
);

it.effect("records nothing for an outcome or a breadcrumb declared outside any span", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryEnvelopeRecording);
    const telemetry = Context.get(services, Telemetry);
    const recorder = Context.get(services, EnvelopeRecorder);

    yield* telemetry.recordOutcome({
      outcome: "succeeded",
      error: Option.none(),
      retryable: false,
    });
    yield* telemetry.addBreadcrumb({
      category: "operation",
      action: "operation_started",
      component: "api",
      outcome: Option.none(),
      error: Option.none(),
      attempt: Option.none(),
      durationMilliseconds: Option.none(),
    });

    expect(yield* recorder.serializedEnvelopes).toHaveLength(0);
  })
);
