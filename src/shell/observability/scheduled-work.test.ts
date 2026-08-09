import { expect, it } from "@effect/vitest";
import { Cause, Context, Data, Deferred, Effect, Exit, Fiber, Layer, Option, Schema } from "effect";
import { decodeEnvelopeItems } from "~/shell/testing/telemetry-fixtures";
import { EnvelopeRecorder, TelemetryEnvelopeRecording } from "./envelope-recorder";
import { ProjectedErrorEvent, ProjectedTransaction } from "./projectors";
import { runScheduledWork } from "./scheduled-work";
import { Telemetry } from "./telemetry";

const payloadsOf = <Decoded, Encoded>(
  schema: Schema.Codec<Decoded, Encoded>,
  envelopes: ReadonlyArray<Uint8Array>
): ReadonlyArray<Decoded> =>
  envelopes
    .flatMap(decodeEnvelopeItems)
    .flatMap((item) => Option.toArray(Schema.decodeUnknownOption(schema)(item)));

class RetentionFailure extends Data.TaggedError("RetentionFailure")<{
  readonly cause: Error;
}> {}

const retentionWork = <A, E, R>(work: Effect.Effect<A, E, R>): Effect.Effect<A, E, R | Telemetry> =>
  runScheduledWork({
    component: "api",
    schedule: "task.auditRetention",
    operationalError: "database_unavailable",
  })(work);

it.effect("starts repeated and concurrent scheduled executions as isolated roots", () =>
  Effect.gen(function* () {
    const services = yield* Layer.build(TelemetryEnvelopeRecording);
    const telemetry = Context.get(services, Telemetry);
    const recorder = Context.get(services, EnvelopeRecorder);
    const observedRetention = <E>(work: Effect.Effect<void, E>): Effect.Effect<void, E> =>
      Effect.provide(retentionWork(work), services);

    yield* telemetry.span(
      {
        component: "api",
        operation: "http.canonicalRequest",
        trigger: "api",
        spanOperation: "http.server",
        workKind: "http_request",
        metadata: { _tag: "Http", method: "GET", status: Option.none() },
      },
      Effect.all([observedRetention(Effect.void), observedRetention(Effect.void)], {
        concurrency: "unbounded",
        discard: true,
      })
    );
    yield* observedRetention(Effect.void);

    const transactions = payloadsOf(ProjectedTransaction, yield* recorder.serializedEnvelopes);
    const scheduled = transactions.filter(
      (transaction) => transaction.transaction === "task.auditRetention"
    );
    const request = transactions.find(
      (transaction) => transaction.transaction === "http.canonicalRequest"
    );

    expect(scheduled).toHaveLength(3);
    expect(new Set(scheduled.map(({ contexts }) => contexts.trace.trace_id)).size).toBe(3);
    expect(scheduled.every(({ contexts }) => contexts.trace.parent_span_id === undefined)).toBe(
      true
    );
    expect(
      scheduled.every(
        ({ contexts }) => contexts.trace.trace_id !== request?.contexts.trace.trace_id
      )
    ).toBe(true);
    expect(
      scheduled
        .map(({ contexts }) => contexts.trace.data)
        .every(
          (data) =>
            data["fidy.component"] === "api" &&
            data["fidy.attempt"] === 1 &&
            typeof data["fidy.duration_milliseconds"] === "number"
        )
    ).toBe(true);
  })
);

it.effect(
  "captures exhausted failures once but not declared outcomes or shutdown interruption",
  () =>
    Effect.gen(function* () {
      const services = yield* Layer.build(TelemetryEnvelopeRecording);
      const telemetry = Context.get(services, Telemetry);
      const recorder = Context.get(services, EnvelopeRecorder);
      const observedRetention = <E>(work: Effect.Effect<void, E>): Effect.Effect<void, E> =>
        Effect.provide(retentionWork(work), services);

      yield* observedRetention(
        telemetry.recordOutcome({
          outcome: "rejected",
          error: Option.some("operational_failure"),
          retryable: false,
        })
      );
      const failed = yield* Effect.exit(
        observedRetention(
          Effect.fail(
            new RetentionFailure({
              cause: new Error("record-id user-id SQL retention-payload sentinel"),
            })
          )
        )
      );
      const interruptionStarted = yield* Deferred.make<void>();
      const interrupted = yield* Effect.forkChild(
        observedRetention(
          Deferred.succeed(interruptionStarted, undefined).pipe(Effect.andThen(Effect.never))
        )
      );
      yield* Deferred.await(interruptionStarted);
      yield* Fiber.interrupt(interrupted);

      expect(Exit.isFailure(failed) && Cause.hasFails(failed.cause)).toBe(true);
      const envelopes = yield* recorder.serializedEnvelopes;
      const errors = payloadsOf(ProjectedErrorEvent, envelopes);
      const transactions = payloadsOf(ProjectedTransaction, envelopes);
      const serialized = envelopes.map((bytes) => new TextDecoder().decode(bytes)).join("\n");

      expect(errors).toHaveLength(1);
      expect(errors[0]?.tags).toMatchObject({
        component: "api",
        operation: "task.auditRetention",
        error: "database_unavailable",
      });
      expect(transactions.map(({ contexts }) => contexts.trace.status)).toEqual([
        "invalid_argument",
        "internal_error",
        "cancelled",
      ]);
      expect(serialized).not.toContain("record-id");
      expect(serialized).not.toContain("user-id");
      expect(serialized).not.toContain("SQL");
      expect(serialized).not.toContain("retention-payload");
    })
);
