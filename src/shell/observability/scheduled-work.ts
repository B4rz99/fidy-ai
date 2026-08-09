import { Cause, Effect, Exit, Option } from "effect";
import { dual } from "effect/Function";
import { TelemetryAttempt } from "./protocol";
import type { TelemetryCode } from "./registry";
import { Telemetry, type TelemetryService } from "./telemetry";

/** A checked-in schedule identity and its fixed exhausted-failure classification. */
export type ScheduledWorkDescriptor = Readonly<{
  component: TelemetryCode<"component">;
  schedule: Extract<TelemetryCode<"operation">, `task.${string}`>;
  operationalError: TelemetryCode<"error">;
}>;

const recordScheduledWorkExit = (
  telemetry: TelemetryService,
  descriptor: ScheduledWorkDescriptor,
  exit: Exit.Exit<unknown, unknown>
): Effect.Effect<void> => {
  if (Exit.isSuccess(exit)) return Effect.void;
  const cause = exit.cause;
  if (Cause.hasInterrupts(cause) && !Cause.hasDies(cause) && !Cause.hasFails(cause)) {
    return telemetry.recordOutcome({
      outcome: "interrupted",
      error: Option.none(),
      retryable: false,
    });
  }
  if (Cause.hasDies(cause)) {
    return Effect.all(
      [
        telemetry.recordOutcome({
          outcome: "failed",
          error: Option.some("unexpected_defect"),
          retryable: false,
        }),
        telemetry.captureFailure({
          _tag: "Defect",
          component: descriptor.component,
          operation: descriptor.schedule,
          error: "unexpected_defect",
          cause,
        }),
      ],
      { discard: true }
    );
  }
  return Effect.all(
    [
      telemetry.recordOutcome({
        outcome: "failed",
        error: Option.some(descriptor.operationalError),
        retryable: true,
      }),
      telemetry.captureFailure({
        _tag: "ExhaustedOperationalFailure",
        component: descriptor.component,
        operation: descriptor.schedule,
        error: descriptor.operationalError,
        provider: Option.none(),
        retryable: true,
        cause,
      }),
    ],
    { discard: true }
  );
};

const observeScheduledWork = <A, E, R>(
  work: Effect.Effect<A, E, R>,
  descriptor: ScheduledWorkDescriptor
): Effect.Effect<A, E, R | Telemetry> =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;
    return yield* telemetry.rootSpan(
      {
        component: descriptor.component,
        operation: descriptor.schedule,
        trigger: "schedule",
        spanOperation: "task.scheduled",
        workKind: "scheduled_execution",
        metadata: { _tag: "Schedule", attempt: TelemetryAttempt.make(1) },
      },
      Effect.onExit(work, (exit) => recordScheduledWorkExit(telemetry, descriptor, exit))
    );
  });

/**
 * Observes one independently triggered execution as an isolated root. The wrapped exit is unchanged;
 * expected outcomes may be declared by the work, pure shutdown interruption is not captured, and an
 * exhausted failure is captured once with only the descriptor's fixed diagnostic codes.
 */
export const runScheduledWork: {
  (
    descriptor: ScheduledWorkDescriptor
  ): <A, E, R>(work: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R | Telemetry>;
  <A, E, R>(
    work: Effect.Effect<A, E, R>,
    descriptor: ScheduledWorkDescriptor
  ): Effect.Effect<A, E, R | Telemetry>;
} = dual(2, observeScheduledWork);
