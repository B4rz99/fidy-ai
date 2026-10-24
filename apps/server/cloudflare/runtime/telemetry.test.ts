import { it } from "@effect/vitest";
import {
  type DurableTraceContext,
  type SpanDescriptor,
  TelemetryAttempt,
  TelemetryCount,
  TelemetryWorkRecord,
} from "../../src/shell/observability/contract";
import { Clock, Deferred, Effect, Exit, Fiber, Option, Schema } from "effect";
import { WorkerTelemetryEvent } from "./telemetry/contract";
import { TestClock } from "effect/testing";
import { expect, vi } from "vitest";
import {
  cloudflareWorkerTelemetry,
  makeWorkerTelemetry,
  observeModelRun,
  observeProviderFetch,
  observeWorkerExecution,
  observeWorkerPromise,
  observeWorkerResponse,
  sanitizeWorkTrace,
  workTraceHeaders,
  workerRelease,
} from "./telemetry/operations";

it.effect("reports a durable attempt without replacing its rejection or exporting its cause", () =>
  Effect.gen(function* () {
    const captured: unknown[] = [];
    const log = vi
      .spyOn(console, "error")
      .mockImplementation((...values: ReadonlyArray<unknown>) => {
        captured.push(...values);
      });
    yield* Effect.addFinalizer(() => Effect.sync(() => log.mockRestore()));
    const failure = new Error("private-financial-payload");
    const result = observeWorkerPromise(() => Promise.reject(failure), {
      environment: { RELEASE_GIT_SHA: "0123456789abcdef0123456789abcdef01234567" },
      telemetry: cloudflareWorkerTelemetry,
      operation: "workflow.billingCollection",
    });
    yield* Effect.tryPromise(() => expect(result).rejects.toBe(failure));
    const records = captured.filter(Schema.is(TelemetryWorkRecord));
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      operation: "workflow.billingCollection",
      outcome: "failed",
      message: "fidy.work operation=workflow.billingCollection outcome=failed statusClass=none",
    });
    expect(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(captured)
    ).not.toContain(failure.message);
  })
);

it.effect("projects release smoke telemetry without proof, probe ID, or User data", () =>
  Effect.gen(function* () {
    const records: TelemetryWorkRecord[] = [];
    const environment = { RELEASE_GIT_SHA: "a".repeat(40), SMOKE_PROOF: "proof-canary" };
    const result = observeWorkerPromise(() => Promise.resolve("probe-canary"), {
      environment,
      telemetry: makeWorkerTelemetry((record) => {
        records.push(record);
      }),
      operation: "workflow.releaseSmoke",
    });
    expect(yield* Effect.tryPromise(() => result)).toBe("probe-canary");
    expect(records).toMatchObject([
      { operation: "workflow.releaseSmoke", outcome: "succeeded", release: "a".repeat(40) },
    ]);
    const projected = records.flatMap((record) => Object.values(record)).join(" ");
    expect(projected).not.toContain("proof-canary");
    expect(projected).not.toContain("probe-canary");
  })
);

it("extracts only a valid release from an environment containing secrets", () => {
  expect(
    workerRelease({ RELEASE_GIT_SHA: "a".repeat(40), RESEND_API_KEY: "secret-canary" })
  ).toEqual({ RELEASE_GIT_SHA: "a".repeat(40) });
});

it.effect(
  "reports unavailable coordinator responses as failures without changing the response",
  () =>
    Effect.gen(function* () {
      const records: TelemetryWorkRecord[] = [];
      const unavailable = new Response(null, { status: 503 });
      const response = yield* Effect.tryPromise(() =>
        observeWorkerResponse(() => Promise.resolve(unavailable), {
          environment: { RELEASE_GIT_SHA: "invalid" },
          telemetry: makeWorkerTelemetry((record) => {
            records.push(record);
          }),
          operation: "worker.core.coordinator",
        })
      );
      expect(response).toBe(unavailable);
      expect(records).toMatchObject([
        { operation: "worker.core.coordinator", outcome: "failed", statusClass: "5xx" },
      ]);
    })
);

it.effect("preserves an interrupted Effect exit and projects one interrupted record", () =>
  Effect.gen(function* () {
    const records: TelemetryWorkRecord[] = [];
    const exit = yield* Effect.tryPromise(() =>
      Effect.runPromiseExit(
        observeWorkerExecution(Effect.interrupt, {
          environment: { RELEASE_GIT_SHA: "invalid" },
          telemetry: makeWorkerTelemetry((record) => {
            records.push(record);
          }),
          operation: "worker.email.receive",
        })
      )
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(records).toMatchObject([{ operation: "worker.email.receive", outcome: "interrupted" }]);
  })
);

it.effect("reports model response status without exporting its prompt or response", () =>
  Effect.gen(function* () {
    const records: TelemetryWorkRecord[] = [];
    const response = Response.json({ privateResponse: "financial-canary" });
    const actual = yield* Effect.tryPromise(() =>
      observeModelRun(() => Promise.resolve(response), {
        environment: { RELEASE_GIT_SHA: "invalid" },
        telemetry: makeWorkerTelemetry((record) => {
          records.push(record);
        }),
      })
    );
    expect(actual).toBe(response);
    expect(records).toMatchObject([
      {
        operation: "model.workersAi",
        provider: "cloudflare-workers-ai",
        release: "unknown",
        statusClass: "2xx",
        outcome: "succeeded",
      },
    ]);
    expect(Object.values(records[0] ?? {}).join(" ")).not.toContain("financial-canary");
  })
);

it.effect("reports only a provider status class, not the response body", () =>
  Effect.gen(function* () {
    const records: TelemetryWorkRecord[] = [];
    const response = Response.json({ secret: "card-canary" }, { status: 502 });
    const fetcher = observeProviderFetch(
      Object.assign(() => Promise.resolve(response), { preconnect: () => {} }),
      {
        provider: "wompi",
        environment: { RELEASE_GIT_SHA: "invalid" },
        telemetry: makeWorkerTelemetry((record) => {
          records.push(record);
        }),
      }
    );
    expect(
      yield* Effect.tryPromise(() => fetcher("https://provider.example/secret?card=card-canary"))
    ).toBe(response);
    expect(records).toMatchObject([
      { operation: "provider.request", provider: "wompi", outcome: "failed", statusClass: "5xx" },
    ]);
    expect(Object.values(records[0] ?? {}).join(" ")).not.toContain("card-canary");
  })
);

it.effect("reports provider transport failure without exporting its destination or request", () =>
  Effect.gen(function* () {
    const records: TelemetryWorkRecord[] = [];
    const failure = new Error("https://secret.example/path?token=private-canary");
    const fetcher = observeProviderFetch(
      Object.assign(() => Promise.reject<Response>(failure), { preconnect: () => {} }),
      {
        provider: "wompi",
        environment: { RELEASE_GIT_SHA: "invalid" },
        telemetry: makeWorkerTelemetry((record) => {
          records.push(record);
        }),
      }
    );
    yield* Effect.tryPromise(() =>
      expect(fetcher("https://secret.example/path?token=private-canary")).rejects.toBe(failure)
    );
    expect(records).toMatchObject([
      { operation: "provider.request", provider: "wompi", outcome: "failed" },
    ]);
    expect(Object.values(records[0] ?? {}).join(" ")).not.toContain("private-canary");
  })
);

it.effect("does not change durable Work outcomes when the exporter throws", () =>
  Effect.gen(function* () {
    const log = vi.spyOn(console, "log").mockImplementation(() => {
      throw new Error("export unavailable");
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => log.mockRestore()));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("failure export unavailable");
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => errors.mockRestore()));
    const result = observeWorkerPromise(() => Promise.resolve("unchanged"), {
      environment: { RELEASE_GIT_SHA: "bad-release" },
      telemetry: cloudflareWorkerTelemetry,
      operation: "workflow.billingCollection",
    });
    expect(yield* Effect.tryPromise(() => result)).toBe("unchanged");
    const failure = new Error("original private failure");
    yield* Effect.tryPromise(() =>
      expect(
        observeWorkerPromise(() => Promise.reject(failure), {
          environment: { RELEASE_GIT_SHA: "bad-release" },
          telemetry: cloudflareWorkerTelemetry,
          operation: "workflow.billingCollection",
        })
      ).rejects.toBe(failure)
    );
  })
);

it.effect("connects root, child and Work exports using server-generated metadata", () =>
  Effect.gen(function* () {
    const events: WorkerTelemetryEvent[] = [];
    const records: TelemetryWorkRecord[] = [];
    const telemetry = makeWorkerTelemetry({
      exportWork: (record) => records.push(record),
      exportEvent: (event) => events.push(event),
    });
    const environment = { RELEASE_GIT_SHA: "a".repeat(40), SECRET: "environment-canary" };
    yield* observeWorkerExecution(
      telemetry.span(
        {
          component: "agent",
          operation: "agent.hostedTurn",
          workKind: "hosted_turn",
          trigger: "queue",
          spanOperation: "agent.turn",
          metadata: { _tag: "None" },
        },
        Effect.void
      ),
      {
        environment,
        telemetry,
        operation: "worker.core.queue",
      }
    );
    const child = events.find(
      (event) => event.event === "span" && event.data["fidy.operation"] === "agent.hostedTurn"
    );
    const root = events.find(
      (event) => event.event === "span" && event.data["fidy.operation"] === "worker.core.queue"
    );
    if (child?.event !== "span" || root?.event !== "span") throw new Error("missing spans");
    expect(child.traceId).toBe(root.traceId);
    expect(child.parentSpanId).toBe(root.spanId);
    expect(child.release).toBe("a".repeat(40));
    expect(records[0]).toMatchObject({ traceId: root.traceId, spanId: root.spanId });
    expect(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(WorkerTelemetryEvent)))(events)
    ).not.toContain("environment-canary");
  })
);

it.effect("retains bounded breadcrumbs and model usage while excluding raw failure content", () =>
  Effect.gen(function* () {
    const captured: unknown[] = [];
    const log = vi.spyOn(console, "log").mockImplementation((...values: ReadonlyArray<unknown>) => {
      captured.push(...values);
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => log.mockRestore()));
    const telemetry = cloudflareWorkerTelemetry;
    yield* telemetry.rootSpan(
      {
        component: "agent",
        operation: "model.workersAi",
        workKind: "model_call",
        trigger: "api",
        spanOperation: "agent.model",
        metadata: { _tag: "Model", model: "workers_ai" },
      },
      Effect.gen(function* () {
        for (let attempt = 1; attempt <= 40; attempt++) {
          yield* telemetry.addBreadcrumb({
            category: "agent",
            action: "model_started",
            component: "agent",
            outcome: Option.none(),
            error: Option.none(),
            attempt: Option.some(TelemetryAttempt.make(attempt)),
            durationMilliseconds: Option.none(),
          });
        }
        yield* telemetry.recordModelUsage({
          attempt: TelemetryAttempt.make(2),
          inputTokens: TelemetryCount.make(123),
          outputTokens: TelemetryCount.make(45),
        });
        yield* telemetry.recordOutcome({
          outcome: "failed",
          error: Option.some("model_response_rejected"),
          retryable: false,
        });
        yield* telemetry.captureFailure({
          _tag: "ExhaustedOperationalFailure",
          component: "agent",
          operation: "model.workersAi",
          error: "model_response_rejected",
          provider: Option.some("cloudflare-workers-ai"),
          retryable: false,
          cause: {
            prompt: "prompt-canary",
            credential: "token-canary",
            url: "https://secret.invalid",
          },
        });
      })
    );
    const events = captured.filter(Schema.is(WorkerTelemetryEvent));
    const span = events.find((event) => event.event === "span");
    if (span?.event !== "span") throw new Error("missing model span");
    expect(span.breadcrumbs).toHaveLength(16);
    expect(span.data).toMatchObject({
      "fidy.outcome": "failed",
      "gen_ai.usage.input_tokens": 123,
      "gen_ai.usage.output_tokens": 45,
      "fidy.attempt": 2,
    });
    expect(span.error).toBe("model_response_rejected");
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "failure",
        traceId: span.traceId,
        spanId: span.spanId,
        message:
          "fidy.failure component=agent operation=model.workersAi error=model_response_rejected classification=ExhaustedOperationalFailure",
      })
    );
    expect(yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(captured)).not.toMatch(
      /prompt-canary|token-canary|secret.invalid/u
    );
  })
);

it.effect("contains span sink failures while cleaning up active trace state", () =>
  Effect.gen(function* () {
    const telemetry = makeWorkerTelemetry({
      exportWork: () => {
        throw new Error("work sink");
      },
      exportEvent: () => {
        throw new Error("event sink");
      },
    });
    const descriptor = {
      component: "api",
      operation: "worker.core.fetch",
      trigger: "api",
      spanOperation: "fidy.operation",
      workKind: "canonical_operation",
      metadata: { _tag: "None" },
    } as const;
    const context = yield* telemetry.rootSpan(descriptor, telemetry.captureDurableContext);
    const result = yield* telemetry.rootSpan(descriptor, Effect.succeed("preserved"));
    expect(result).toBe("preserved");
    expect(yield* telemetry.captureDurableContext).toEqual(Option.none());
    expect(yield* telemetry.isActiveSpan(Option.getOrThrow(context), "worker.core.fetch")).toBe(
      false
    );
    const failed = yield* Effect.exit(telemetry.rootSpan(descriptor, Effect.fail("authoritative")));
    expect(Exit.findErrorOption(failed)).toEqual(Option.some("authoritative"));
  })
);

it.effect("does not revive stale or malformed durable trace authority into private headers", () =>
  Effect.gen(function* () {
    const context = {
      version: 1,
      traceId: "1".repeat(32),
      parentSpanId: "2".repeat(16),
      sampled: true,
      capturedAtUnixMilliseconds: 0,
    };
    yield* TestClock.adjust("25 hours");
    expect(yield* workTraceHeaders({ traceContext: context })).toEqual({});
    const now = yield* Clock.currentTimeMillis;
    expect(
      yield* workTraceHeaders({
        traceContext: {
          ...context,
          capturedAtUnixMilliseconds: now,
          credential: "credential-canary",
        },
      })
    ).toEqual({});
    expect(
      yield* workTraceHeaders({
        traceContext: { ...context, capturedAtUnixMilliseconds: now, traceId: "0".repeat(32) },
      })
    ).toEqual({});
    expect(
      yield* workTraceHeaders({ traceContext: { ...context, capturedAtUnixMilliseconds: now } })
    ).toEqual({ "x-fidy-traceparent": `00-${context.traceId}-${context.parentSpanId}-01` });
  })
);

it.effect("runs authoritative work when hostile span metadata prevents startup", () =>
  Effect.gen(function* () {
    const events: WorkerTelemetryEvent[] = [];
    const telemetry = makeWorkerTelemetry({
      exportWork: () => undefined,
      exportEvent: (event) => events.push(event),
    });
    const descriptor: SpanDescriptor = {
      component: "api",
      operation: "worker.core.fetch",
      trigger: "api",
      spanOperation: "fidy.operation",
      workKind: "canonical_operation",
      get metadata(): Readonly<{ _tag: "None" }> {
        throw new Error("private-startup-sentinel");
      },
    };
    expect(yield* telemetry.rootSpan(descriptor, Effect.succeed("authoritative"))).toBe(
      "authoritative"
    );
    expect(events).toEqual([]);
  })
);

it.effect("bounds simultaneous active spans and releases capacity after completion", () =>
  Effect.gen(function* () {
    const events: WorkerTelemetryEvent[] = [];
    const telemetry = makeWorkerTelemetry({
      exportWork: () => undefined,
      exportEvent: (event) => events.push(event),
    });
    const descriptor = {
      component: "api",
      operation: "worker.core.fetch",
      trigger: "api",
      spanOperation: "fidy.operation",
      workKind: "canonical_operation",
      metadata: { _tag: "None" },
    } as const;
    const ready = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let started = 0;
    const contexts: Array<Option.Option<DurableTraceContext>> = [];
    const fiber = yield* Effect.all(
      Array.from({ length: 1025 }, () =>
        telemetry.rootSpan(
          descriptor,
          Effect.gen(function* () {
            contexts.push(yield* telemetry.captureDurableContext);
            started++;
            if (started === 1025) yield* Deferred.succeed(ready, undefined);
            yield* Deferred.await(release);
          })
        )
      ),
      { concurrency: "unbounded", discard: true }
    ).pipe(Effect.forkChild);
    yield* Deferred.await(ready);
    expect(contexts.filter(Option.isSome)).toHaveLength(1024);
    expect(contexts.filter(Option.isNone)).toHaveLength(1);
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(fiber);
    expect(events).toHaveLength(1024);
    expect(
      Option.isSome(yield* telemetry.rootSpan(descriptor, telemetry.captureDurableContext))
    ).toBe(true);
  })
);

it.effect(
  "preserves safe typed-failure classifications while overriding misleading success on defects",
  () =>
    Effect.gen(function* () {
      const events: WorkerTelemetryEvent[] = [];
      const telemetry = makeWorkerTelemetry({
        exportWork: () => undefined,
        exportEvent: (event) => events.push(event),
      });
      const descriptor = {
        component: "agent",
        operation: "agent.modelRound",
        trigger: "api",
        spanOperation: "agent.model",
        workKind: "model_round",
        metadata: { _tag: "None" },
      } as const;
      const rejected = yield* Effect.exit(
        telemetry.span(
          descriptor,
          telemetry
            .recordOutcome({
              outcome: "rejected",
              error: Option.some("model_response_rejected"),
              retryable: false,
            })
            .pipe(Effect.andThen(Effect.fail("payload-canary")))
        )
      );
      expect(Exit.findErrorOption(rejected)).toEqual(Option.some("payload-canary"));
      expect(
        events.find((event) => event.event === "span" && event.error === "model_response_rejected")
      ).toMatchObject({
        event: "span",
        error: "model_response_rejected",
        data: { "fidy.outcome": "rejected" },
      });
      yield* Effect.exit(
        telemetry.span(
          descriptor,
          telemetry
            .recordOutcome({ outcome: "succeeded", error: Option.none(), retryable: false })
            .pipe(Effect.andThen(Effect.die("defect-canary")))
        )
      );
      expect(
        events.find((event) => event.event === "span" && event.error === "unexpected_defect")
      ).toMatchObject({
        event: "span",
        error: "unexpected_defect",
        data: { "fidy.outcome": "failed" },
      });
    })
);

it.effect("exports bounded hosted round usage only from an approved model span", () =>
  Effect.gen(function* () {
    const events: WorkerTelemetryEvent[] = [];
    const telemetry = makeWorkerTelemetry({
      exportWork: () => undefined,
      exportEvent: (event) => events.push(event),
    });
    const usage = {
      attempt: TelemetryAttempt.make(2),
      inputTokens: TelemetryCount.make(12),
      outputTokens: TelemetryCount.make(3),
    };
    yield* telemetry.span(
      {
        component: "agent",
        operation: "agent.modelRound",
        trigger: "api",
        spanOperation: "agent.model",
        workKind: "model_round",
        metadata: { _tag: "None" },
      },
      telemetry.recordModelUsage(usage)
    );
    yield* telemetry.span(
      {
        component: "api",
        operation: "worker.core.fetch",
        trigger: "api",
        spanOperation: "fidy.operation",
        workKind: "canonical_operation",
        metadata: { _tag: "None" },
      },
      telemetry.recordModelUsage(usage)
    );
    const model = events.find(
      (event) => event.event === "span" && event.data["fidy.operation"] === "agent.modelRound"
    );
    const ordinary = events.find(
      (event) => event.event === "span" && event.data["fidy.operation"] === "worker.core.fetch"
    );
    expect(model).toMatchObject({
      data: {
        "gen_ai.request.model": "hosted_inference",
        "gen_ai.usage.input_tokens": 12,
        "gen_ai.usage.output_tokens": 3,
        "fidy.attempt": 2,
      },
    });
    if (ordinary?.event !== "span") throw new Error("missing ordinary span");
    expect(ordinary.data).not.toHaveProperty("gen_ai.usage.input_tokens");
  })
);

it.effect(
  "removes malformed durable diagnostics while preserving the decoded domain envelope",
  () =>
    Effect.gen(function* () {
      yield* TestClock.adjust("25 hours");
      const now = yield* Clock.currentTimeMillis;
      const context = {
        version: 1,
        traceId: "1".repeat(32),
        parentSpanId: "2".repeat(16),
        sampled: true,
        capturedAtUnixMilliseconds: now,
      };
      const work = { version: 1, operation: "durable-domain-work", identity: "owned-work" };
      for (const traceContext of [
        "bearer-canary",
        { ...context, payload: "private-canary" },
        { ...context, capturedAtUnixMilliseconds: 0 },
        { ...context, capturedAtUnixMilliseconds: now + 1 },
        { ...context, traceId: "0".repeat(32) },
      ]) {
        expect(yield* sanitizeWorkTrace({ ...work, traceContext })).toEqual(work);
      }
      expect(yield* sanitizeWorkTrace({ ...work, traceContext: context })).toEqual({
        ...work,
        traceContext: context,
      });
      expect(yield* sanitizeWorkTrace(work)).toEqual(work);
    })
);
