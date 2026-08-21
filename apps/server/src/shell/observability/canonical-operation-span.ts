import { Effect, Option, Schema } from "effect";
import { type DeclaredOutcome, type SpanDescriptor } from "./protocol";
import { type TelemetryCode, TelemetryCodeSchema } from "./registry";
import type { TelemetryService } from "./telemetry";

const ExpectedFailure = Schema.Struct({
  error: Schema.Struct({ code: TelemetryCodeSchema.error }),
});

/** Reads the declared error contract out of one canonical failure, ignoring undeclared shapes. */
export const expectedOutcome = (failure: unknown): Option.Option<DeclaredOutcome> =>
  Option.map(Schema.decodeUnknownOption(ExpectedFailure)(failure), ({ error }) => ({
    outcome: "rejected",
    error: Option.some(error.code),
    retryable: false,
  }));

/**
 * The canonical operation span shared by HTTP-dispatched and hosted in-process execution, so both
 * paths remain observable through the same descriptor.
 */
export const operationDescriptor = (operation: TelemetryCode<"operation">): SpanDescriptor => ({
  component: "api",
  operation,
  trigger: "api",
  spanOperation: "fidy.operation",
  workKind: "canonical_operation",
  metadata: { _tag: "None" },
});

/** Records a declared canonical rejection as an outcome rather than an unexpected failure. */
export const recordExpectedOutcome =
  (telemetry: TelemetryService) =>
  (failure: unknown): Effect.Effect<void> =>
    Option.match(expectedOutcome(failure), {
      onNone: () => Effect.void,
      onSome: telemetry.recordOutcome,
    });
