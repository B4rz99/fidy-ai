import * as Arr from "effect/Array";
import { Cause, Effect, Schema } from "effect";
import type { TelemetryCode } from "~/shell/observability/registry";
import { Telemetry, type TelemetryService } from "~/shell/observability/telemetry";

/** The only retry causes that this boundary permits PersistedQueue to render durably. */
export const PersistedQueueHandlerFailure = Schema.TaggedStruct("PersistedQueueHandlerFailure", {
  reason: Schema.Literals(["transient", "unexpected-defect"]),
});
export type PersistedQueueHandlerFailure = typeof PersistedQueueHandlerFailure.Type;

/** Bounded permanent rejection classes that an owning consumer may record as terminal state. */
export const PersistedQueueTerminalReason = Schema.Literals([
  "payload-rejected",
  "identity-rejected",
  "domain-rejected",
]);
export type PersistedQueueTerminalReason = typeof PersistedQueueTerminalReason.Type;

/** A consumer's exhaustive decision for one expected handler failure. */
export const PersistedQueueFailureDisposition = Schema.Union([
  Schema.TaggedStruct("Retry", { reason: Schema.Literal("transient") }),
  Schema.TaggedStruct("Terminal", { reason: PersistedQueueTerminalReason }),
]);
export type PersistedQueueFailureDisposition = typeof PersistedQueueFailureDisposition.Type;

type QueueHandlerDescriptor = Readonly<{
  component: TelemetryCode<"component">;
  operation: TelemetryCode<"operation">;
}>;

/**
 * Policy supplied by an owning queue consumer. Classification must be total for the handler's typed
 * failures. Recording a terminal reason must idempotently establish the owning domain disposition
 * because the queue may replay it; if that write fails, the item remains retryable rather than
 * completing without its evidence.
 *
 * The consumer remains responsible for its bounded Work span, latency, retry, and continuation
 * metrics because it owns the operation-specific safe metadata. This boundary observes only
 * unexpected defects so it neither duplicates consumer telemetry nor raises expected dispositions.
 */
export type PersistedQueueHandlerOptions<HandlerFailure, TerminalError, TerminalRequirements> =
  Readonly<{
    descriptor: QueueHandlerDescriptor;
    classify: (failure: HandlerFailure) => PersistedQueueFailureDisposition;
    recordTerminal: (
      reason: PersistedQueueTerminalReason
    ) => Effect.Effect<void, TerminalError, TerminalRequirements>;
  }>;

const makeHandlerFailure = (
  reason: PersistedQueueHandlerFailure["reason"]
): PersistedQueueHandlerFailure => ({
  _tag: "PersistedQueueHandlerFailure",
  reason,
});

const failRedacted = <Failure extends unknown>(
  cause: Cause.Cause<Failure>,
  reason: PersistedQueueHandlerFailure["reason"]
): Effect.Effect<never, PersistedQueueHandlerFailure> =>
  Effect.failCause(Cause.map(cause, () => makeHandlerFailure(reason)));

const observeDefect = (
  telemetry: TelemetryService,
  descriptor: QueueHandlerDescriptor,
  cause: Cause.Cause<unknown>
): Effect.Effect<void> =>
  telemetry.captureFailure({
    _tag: "Defect",
    component: descriptor.component,
    operation: descriptor.operation,
    error: "unexpected_defect",
    cause,
  });

const captureDefect = (
  telemetry: TelemetryService,
  descriptor: QueueHandlerDescriptor,
  cause: Cause.Cause<unknown>
): Effect.Effect<never, PersistedQueueHandlerFailure> =>
  observeDefect(telemetry, descriptor, cause).pipe(
    Effect.andThen(Effect.fail(makeHandlerFailure("unexpected-defect")))
  );

const expectedFailures = <Failure extends unknown>(
  cause: Cause.Cause<Failure>
): ReadonlyArray<Failure> =>
  Arr.filter(cause.reasons, Cause.isFailReason).map((reason) => reason.error);

const interruptionOnly = <Failure extends unknown>(
  cause: Cause.Cause<Failure>
): Cause.Cause<never> => Cause.fromReasons(Arr.filter(cause.reasons, Cause.isInterruptReason));

const recordTerminal = <HandlerFailure, TerminalError, TerminalRequirements>(
  reason: PersistedQueueTerminalReason,
  options: PersistedQueueHandlerOptions<HandlerFailure, TerminalError, TerminalRequirements>,
  telemetry: TelemetryService
): Effect.Effect<void, PersistedQueueHandlerFailure, TerminalRequirements> =>
  Effect.suspend(() => options.recordTerminal(reason)).pipe(
    Effect.catchCause((cause) =>
      Cause.hasDies(cause)
        ? captureDefect(telemetry, options.descriptor, cause)
        : failRedacted(cause, "transient")
    ),
    Effect.asVoid
  );

const classifyFailures = <HandlerFailure, TerminalError, TerminalRequirements>(
  failures: ReadonlyArray<HandlerFailure>,
  options: PersistedQueueHandlerOptions<HandlerFailure, TerminalError, TerminalRequirements>,
  telemetry: TelemetryService
): Effect.Effect<void, PersistedQueueHandlerFailure, TerminalRequirements> =>
  Effect.sync(() => failures.map(options.classify)).pipe(
    Effect.catchCause((cause) => captureDefect(telemetry, options.descriptor, cause)),
    Effect.flatMap((dispositions) => {
      const terminalReasons = new Set<PersistedQueueTerminalReason>();
      for (const disposition of dispositions) {
        if (disposition._tag === "Retry") return Effect.fail(makeHandlerFailure("transient"));
        terminalReasons.add(disposition.reason);
      }
      return Effect.forEach(
        Array.from(terminalReasons),
        (reason) => recordTerminal(reason, options, telemetry),
        { discard: true }
      );
    })
  );

const redactInterruptedCause = <HandlerFailure, TerminalError, TerminalRequirements>(
  cause: Cause.Cause<HandlerFailure>,
  options: PersistedQueueHandlerOptions<HandlerFailure, TerminalError, TerminalRequirements>,
  telemetry: TelemetryService
): Effect.Effect<void, PersistedQueueHandlerFailure, TerminalRequirements> => {
  const interrupted = Effect.failCause(interruptionOnly(cause));
  if (Cause.hasDies(cause)) {
    return observeDefect(telemetry, options.descriptor, cause).pipe(Effect.andThen(interrupted));
  }
  return interrupted;
};

const redactExpectedCause = <HandlerFailure, TerminalError, TerminalRequirements>(
  cause: Cause.Cause<HandlerFailure>,
  options: PersistedQueueHandlerOptions<HandlerFailure, TerminalError, TerminalRequirements>,
  telemetry: TelemetryService
): Effect.Effect<void, PersistedQueueHandlerFailure, TerminalRequirements> => {
  const failures = expectedFailures(cause);
  if (!Arr.isReadonlyArrayNonEmpty(failures)) {
    return captureDefect(telemetry, options.descriptor, cause);
  }
  return classifyFailures(failures, options, telemetry);
};

const redactUninterruptedCause = <HandlerFailure, TerminalError, TerminalRequirements>(
  cause: Cause.Cause<HandlerFailure>,
  options: PersistedQueueHandlerOptions<HandlerFailure, TerminalError, TerminalRequirements>,
  telemetry: TelemetryService
): Effect.Effect<void, PersistedQueueHandlerFailure, TerminalRequirements> => {
  if (Cause.hasDies(cause)) return captureDefect(telemetry, options.descriptor, cause);
  return redactExpectedCause(cause, options, telemetry);
};

const redactHandlerCause = <HandlerFailure, TerminalError, TerminalRequirements>(
  cause: Cause.Cause<HandlerFailure>,
  options: PersistedQueueHandlerOptions<HandlerFailure, TerminalError, TerminalRequirements>,
  telemetry: TelemetryService
): Effect.Effect<void, PersistedQueueHandlerFailure, TerminalRequirements> => {
  if (Cause.hasInterrupts(cause)) return redactInterruptedCause(cause, options, telemetry);
  return redactUninterruptedCause(cause, options, telemetry);
};

/**
 * Converts one opt-in PersistedQueue handler execution to a closed durable failure vocabulary.
 * Expected transient failures retry, permanent rejections complete only after their bounded outcome
 * is recorded, unexpected defects are captured once, and interruption-only causes are unchanged.
 */
export const runPersistedQueueHandler =
  <HandlerFailure, TerminalError, TerminalRequirements>(
    options: PersistedQueueHandlerOptions<HandlerFailure, TerminalError, TerminalRequirements>
  ) =>
  <A, R>(
    work: Effect.Effect<A, HandlerFailure, R>
  ): Effect.Effect<void, PersistedQueueHandlerFailure, R | TerminalRequirements | Telemetry> =>
    Effect.gen(function* () {
      const telemetry = yield* Telemetry;
      return yield* work.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) => redactHandlerCause(cause, options, telemetry))
      );
    });
