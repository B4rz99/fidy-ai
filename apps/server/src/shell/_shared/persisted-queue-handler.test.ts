import { expect, it } from "@effect/vitest";
import { Cause, Context, Effect, Exit, Layer, Ref, Schema } from "effect";
import { TestConsole } from "effect/testing";
import { PersistedQueue } from "effect/unstable/persistence";
import { TelemetryDisabled } from "~/shell/observability/operations";
import { EnvelopeRecorder, TelemetryEnvelopeRecording } from "~/shell/testing/telemetry-harness";
import { makePersistedQueue } from "./persisted-queue";
import type {
  PersistedQueueFailureDisposition,
  PersistedQueueTerminalReason,
} from "./persisted-queue-handler";

const descriptor = {
  component: "whatsapp",
  operation: "whatsapp.processWork",
} as const;

const QueuePayload = Schema.Struct({ value: Schema.String });
const GuardedQueue = makePersistedQueue({
  name: "handler-boundary-guarded",
  schema: QueuePayload,
  descriptor,
});
const QueueMemory = PersistedQueue.layer.pipe(Layer.provideMerge(PersistedQueue.layerStoreMemory));

it.effect("requires classification and terminal settlement at the application queue take", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(QueueMemory);
    const queue = yield* GuardedQueue.pipe(Effect.provide(services));
    const recorded = yield* Ref.make<
      ReadonlyArray<{
        readonly value: string;
        readonly id: string;
        readonly reason: PersistedQueueTerminalReason;
      }>
    >([]);
    yield* queue.offer({ value: "terminal-payload" }, { id: "handler-boundary-terminal-policy" });

    yield* queue
      .take(() => Effect.fail("terminal-domain-failure"), {
        classify: (): PersistedQueueFailureDisposition => ({
          _tag: "Terminal",
          reason: "domain-rejected",
        }),
        recordTerminal: (payload, metadata, reason) =>
          Ref.update(recorded, (values) => [
            ...values,
            { value: payload.value, id: metadata.id, reason },
          ]),
      })
      .pipe(Effect.provide(services));

    expect(yield* Ref.get(recorded)).toEqual([
      {
        value: "terminal-payload",
        id: "handler-boundary-terminal-policy",
        reason: "domain-rejected",
      },
    ]);
  })
);

it.effect("redacts and observes a defect that bypasses the owning queue handler policy", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(Layer.mergeAll(TelemetryEnvelopeRecording, QueueMemory));
    const recorder = Context.get(services, EnvelopeRecorder);
    const queue = yield* GuardedQueue.pipe(Effect.provide(services));
    yield* queue.offer({ value: "payload-sentinel" }, { id: "handler-boundary-guarded" });

    const exit = yield* Effect.exit(
      queue
        .take(() => Effect.die(new Error("secret-defect-sentinel")), {
          classify: (failure: never) => failure,
          recordTerminal: () => Effect.void,
        })
        .pipe(Effect.provide(services))
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) return;
    const durableFailureText = Cause.pretty(exit.cause);
    expect(durableFailureText).toContain('"reason":"unexpected-defect"');
    expect(durableFailureText).not.toContain("secret-defect-sentinel");
    const envelopes = yield* recorder.serializedEnvelopes;
    expect(envelopes).toHaveLength(1);
    expect(new TextDecoder().decode(envelopes[0])).not.toContain("secret-defect-sentinel");
  })
);

it.effect("logs defects even when configured telemetry is disabled", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(Layer.mergeAll(TelemetryDisabled, QueueMemory));
    const queue = yield* GuardedQueue.pipe(Effect.provide(services));
    yield* queue.offer({ value: "payload-sentinel" }, { id: "handler-boundary-disabled" });

    yield* Effect.exit(
      queue
        .take(() => Effect.die(new Error("disabled-secret-sentinel")), {
          classify: (failure: never) => failure,
          recordTerminal: () => Effect.void,
        })
        .pipe(Effect.provide(services))
    );

    const observableText = [
      ...(yield* TestConsole.errorLines),
      ...(yield* TestConsole.logLines),
    ].join("\n");
    expect(observableText).toContain("Persisted queue handler defect");
    expect(observableText).not.toContain("disabled-secret-sentinel");
  })
);

it.effect("uses metadata-only defect logging when telemetry is absent", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(QueueMemory);
    const queue = yield* GuardedQueue.pipe(Effect.provide(services));
    yield* queue.offer({ value: "payload-sentinel" }, { id: "handler-boundary-fallback" });

    const exit = yield* Effect.exit(
      queue
        .take(() => Effect.die(new Error("fallback-secret-sentinel")), {
          classify: (failure: never) => failure,
          recordTerminal: () => Effect.void,
        })
        .pipe(Effect.provide(services))
    );

    expect(Exit.isFailure(exit)).toBe(true);
    const observableText = [
      ...(yield* TestConsole.errorLines),
      ...(yield* TestConsole.logLines),
    ].join("\n");
    expect(observableText).toContain("Persisted queue handler defect");
    expect(observableText).toContain("whatsapp");
    expect(observableText).not.toContain("fallback-secret-sentinel");
  })
);
