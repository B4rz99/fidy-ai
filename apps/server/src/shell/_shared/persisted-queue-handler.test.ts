import { expect, it } from "@effect/vitest";
import { Cause, Context, Effect, Equal, Exit, Layer, Ref, Schema } from "effect";
import { TestConsole } from "effect/testing";
import { PersistedQueue } from "effect/unstable/persistence";
import { TelemetryDisabled } from "~/shell/observability/disabled";
import {
  EnvelopeRecorder,
  TelemetryEnvelopeRecording,
} from "~/shell/observability/envelope-recorder";
import {
  type PersistedQueueFailureDisposition,
  type PersistedQueueHandlerOptions,
  type PersistedQueueTerminalReason,
  runPersistedQueueHandler,
} from "./persisted-queue-handler";

const descriptor = {
  component: "whatsapp",
  operation: "whatsapp.processWork",
} as const;

const retryHandlerOptions = <HandlerFailure>(): PersistedQueueHandlerOptions<
  HandlerFailure,
  never,
  never
> => ({
  descriptor,
  classify: (): PersistedQueueFailureDisposition => ({ _tag: "Retry", reason: "transient" }),
  recordTerminal: (): Effect.Effect<void> => Effect.void,
});

const terminalHandlerOptions = <HandlerFailure, TerminalError, TerminalRequirements>(
  reason: PersistedQueueTerminalReason,
  recordTerminal: (
    terminalReason: PersistedQueueTerminalReason
  ) => Effect.Effect<void, TerminalError, TerminalRequirements>
): PersistedQueueHandlerOptions<HandlerFailure, TerminalError, TerminalRequirements> => ({
  descriptor,
  classify: (): PersistedQueueFailureDisposition => ({ _tag: "Terminal", reason }),
  recordTerminal,
});

const appendTerminal =
  (
    recorded: Ref.Ref<ReadonlyArray<PersistedQueueTerminalReason>>
  ): ((reason: PersistedQueueTerminalReason) => Effect.Effect<void>) =>
  (reason) =>
    Ref.update(recorded, (current) => [...current, reason]);

const terminalReasons: ReadonlyArray<PersistedQueueTerminalReason> = [
  "payload-rejected",
  "identity-rejected",
  "domain-rejected",
];

const QueueHarness = Layer.mergeAll(
  TelemetryDisabled,
  PersistedQueue.layer.pipe(Layer.provideMerge(PersistedQueue.layerStoreMemory))
);
const QueuePayload = Schema.Struct({ value: Schema.String });
const RetryQueue = PersistedQueue.make({ name: "handler-boundary-retry", schema: QueuePayload });
const TerminalQueue = PersistedQueue.make({
  name: "handler-boundary-terminal",
  schema: QueuePayload,
});
const InterruptQueue = PersistedQueue.make({
  name: "handler-boundary-interrupt",
  schema: QueuePayload,
});

it.effect("replaces an expected transient failure with the stable retry marker", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryDisabled);
    const sensitiveFailure = {
      _tag: "ProviderFailure",
      message: "provider-response-sentinel",
      secret: "secret-sentinel",
    } as const;
    const exit = yield* Effect.exit(
      Effect.fail(sensitiveFailure).pipe(
        runPersistedQueueHandler(retryHandlerOptions<typeof sensitiveFailure>()),
        Effect.provide(services)
      )
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) return;
    const durableFailureText = Cause.pretty(exit.cause);
    expect(durableFailureText).toContain("PersistedQueueHandlerFailure");
    expect(durableFailureText).toContain('"reason":"transient"');
    expect(durableFailureText).not.toContain("provider-response-sentinel");
    expect(durableFailureText).not.toContain("secret-sentinel");
  })
);

it.effect("lets PersistedQueue count the stable transient marker as a retry attempt", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(QueueHarness);
    const queue = yield* RetryQueue.pipe(Effect.provide(services));
    yield* queue.offer({ value: "payload-retry-sentinel" }, { id: "handler-boundary-retry" });

    const first = yield* Effect.exit(
      queue.take((payload) =>
        Effect.fail({ detail: payload.value }).pipe(
          runPersistedQueueHandler(retryHandlerOptions<{ detail: string }>()),
          Effect.provide(services)
        )
      )
    );
    expect(Exit.isFailure(first)).toBe(true);
    if (Exit.isFailure(first)) {
      expect(Cause.pretty(first.cause)).not.toContain("payload-retry-sentinel");
    }

    const attempts = yield* queue.take((_, metadata) => Effect.succeed(metadata.attempts));
    expect(attempts).toBe(1);
  })
);

it.effect("records each permanent rejection and completes without a retry failure", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryDisabled);
    const recorded = yield* Ref.make<ReadonlyArray<PersistedQueueTerminalReason>>([]);

    for (const reason of terminalReasons) {
      yield* Effect.fail({ reason }).pipe(
        runPersistedQueueHandler(
          terminalHandlerOptions<{ reason: PersistedQueueTerminalReason }, never, never>(
            reason,
            appendTerminal(recorded)
          )
        ),
        Effect.provide(services)
      );
    }

    expect(yield* Ref.get(recorded)).toEqual(terminalReasons);
  })
);

it.effect("lets PersistedQueue complete a permanently rejected item after recording it", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(QueueHarness);
    const queue = yield* TerminalQueue.pipe(Effect.provide(services));
    const recorded = yield* Ref.make<ReadonlyArray<PersistedQueueTerminalReason>>([]);
    yield* queue.offer({ value: "terminal" }, { id: "handler-boundary-terminal" });

    yield* queue.take(() =>
      Effect.fail("domain-rejection-sentinel").pipe(
        runPersistedQueueHandler(
          terminalHandlerOptions<string, never, never>("domain-rejected", appendTerminal(recorded))
        ),
        Effect.provide(services)
      )
    );

    expect(yield* Ref.get(recorded)).toEqual(["domain-rejected"]);
  })
);

it.effect("captures an unexpected defect once without leaking sensitive values", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryEnvelopeRecording);
    const recorder = Context.get(services, EnvelopeRecorder);
    const hostileDefect = Object.assign(
      new Error(
        "payload-sentinel identifier-sentinel provider-response-sentinel sql-detail-sentinel secret-sentinel"
      ),
      {
        payload: "payload-property-sentinel",
        secret: "secret-property-sentinel",
      }
    );
    const exit = yield* Effect.exit(
      Effect.die(hostileDefect).pipe(
        runPersistedQueueHandler(retryHandlerOptions<never>()),
        Effect.provide(services)
      )
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) return;
    const durableFailureText = Cause.pretty(exit.cause);
    expect(durableFailureText).toContain('"reason":"unexpected-defect"');
    const envelopes = yield* recorder.serializedEnvelopes;
    expect(envelopes).toHaveLength(1);
    const observableText = [
      durableFailureText,
      ...envelopes.map((bytes) => new TextDecoder().decode(bytes)),
      ...(yield* TestConsole.logLines),
      ...(yield* TestConsole.errorLines),
    ].join("\n");
    for (const sentinel of [
      "payload-sentinel",
      "identifier-sentinel",
      "provider-response-sentinel",
      "sql-detail-sentinel",
      "secret-sentinel",
      "payload-property-sentinel",
      "secret-property-sentinel",
    ]) {
      expect(observableText).not.toContain(sentinel);
    }
  })
);

it.effect("propagates pure interruption with its original cause", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryDisabled);
    const interruption = Cause.interrupt(42);
    const exit = yield* Effect.exit(
      Effect.failCause(interruption).pipe(
        runPersistedQueueHandler(retryHandlerOptions<never>()),
        Effect.provide(services)
      )
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) return;
    expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(Equal.equals(exit.cause, interruption)).toBe(true);
  })
);

it.effect("keeps a transient failure retryable when another concurrent failure is terminal", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryDisabled);
    const recorded = yield* Ref.make<ReadonlyArray<PersistedQueueTerminalReason>>([]);
    const failures = Cause.combine(
      Cause.fail("domain-rejection-sentinel"),
      Cause.fail("transient-sentinel")
    );
    const exit = yield* Effect.exit(
      Effect.failCause(failures).pipe(
        runPersistedQueueHandler({
          descriptor,
          classify: (failure): PersistedQueueFailureDisposition =>
            failure === "transient-sentinel"
              ? { _tag: "Retry", reason: "transient" }
              : { _tag: "Terminal", reason: "domain-rejected" },
          recordTerminal: appendTerminal(recorded),
        }),
        Effect.provide(services)
      )
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) return;
    expect(Cause.pretty(exit.cause)).toContain('"reason":"transient"');
    expect(yield* Ref.get(recorded)).toEqual([]);
  })
);

it.effect("lets interruption win over a concurrent permanent rejection", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryDisabled);
    const recorded = yield* Ref.make<ReadonlyArray<PersistedQueueTerminalReason>>([]);
    const interruption = Cause.interrupt(99);
    const exit = yield* Effect.exit(
      Effect.failCause(Cause.combine(Cause.fail("domain-rejection-sentinel"), interruption)).pipe(
        runPersistedQueueHandler(
          terminalHandlerOptions<string, never, never>("domain-rejected", appendTerminal(recorded))
        ),
        Effect.provide(services)
      )
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) return;
    expect(Equal.equals(exit.cause, interruption)).toBe(true);
    expect(yield* Ref.get(recorded)).toEqual([]);
  })
);

it.effect("lets PersistedQueue release an interrupted item without consuming an attempt", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(QueueHarness);
    const queue = yield* InterruptQueue.pipe(Effect.provide(services));
    yield* queue.offer({ value: "interrupted" }, { id: "handler-boundary-interrupt" });

    const first = yield* Effect.exit(
      queue.take(() =>
        Effect.failCause(Cause.interrupt(42)).pipe(
          runPersistedQueueHandler(retryHandlerOptions<never>()),
          Effect.provide(services)
        )
      )
    );
    expect(Exit.isFailure(first) && Cause.hasInterruptsOnly(first.cause)).toBe(true);

    const attempts = yield* queue.take((_, metadata) => Effect.succeed(metadata.attempts));
    expect(attempts).toBe(0);
  })
);

it.effect("keeps a failed terminal disposition retryable without exposing its cause", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryDisabled);
    const exit = yield* Effect.exit(
      Effect.fail("domain-rejection-sentinel").pipe(
        runPersistedQueueHandler(
          terminalHandlerOptions<string, string, never>("domain-rejected", () =>
            Effect.fail("sql-terminal-record-sentinel")
          )
        ),
        Effect.provide(services)
      )
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) return;
    const durableFailureText = Cause.pretty(exit.cause);
    expect(durableFailureText).toContain('"reason":"transient"');
    expect(durableFailureText).not.toContain("domain-rejection-sentinel");
    expect(durableFailureText).not.toContain("sql-terminal-record-sentinel");
  })
);
