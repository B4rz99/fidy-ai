import { Cause, Effect, Layer, Option, Schema } from "effect";
import { CanonicalTelemetry } from "~/shell/_shared/canonical-telemetry";
import { operationCatalog } from "~/shell/api";
import {
  type DeclaredOutcome,
  type SpanDescriptor,
  TelemetryHttpMethod,
  type TelemetryHttpMethod as TelemetryHttpMethodType,
} from "./protocol";
import { type TelemetryCode, TelemetryCodeSchema } from "./registry";
import { Telemetry, type TelemetryService } from "./telemetry";

const expectedOutcome = (failure: unknown): Option.Option<DeclaredOutcome> => {
  if (typeof failure !== "object" || failure === null || !("error" in failure)) {
    return Option.none();
  }
  const detail = failure.error;
  if (typeof detail !== "object" || detail === null || !("code" in detail)) {
    return Option.none();
  }
  return Option.map(
    Schema.decodeUnknownOption(TelemetryCodeSchema.error)(detail.code),
    (error) => ({ outcome: "rejected", error: Option.some(error), retryable: false })
  );
};

const httpDescriptor = (input: {
  readonly method: TelemetryHttpMethodType;
  readonly route: TelemetryCode<"httpRoute">;
}): SpanDescriptor => ({
  component: "api",
  operation: "http.canonicalRequest",
  trigger: "api",
  spanOperation: "http.server",
  workKind: "http_request",
  metadata: { _tag: "Http", ...input, status: Option.none() },
});

const operationDescriptor = (operation: TelemetryCode<"operation">): SpanDescriptor => ({
  component: "api",
  operation,
  trigger: "api",
  spanOperation: "fidy.operation",
  workKind: "canonical_operation",
  metadata: { _tag: "None" },
});

const recordExpectedOutcome =
  (telemetry: TelemetryService) =>
  (failure: unknown): Effect.Effect<void> =>
    Option.match(expectedOutcome(failure), {
      onNone: () => Effect.void,
      onSome: telemetry.recordOutcome,
    });

const captureUnexpectedDefect =
  (telemetry: TelemetryService, operation: TelemetryCode<"operation">) =>
  (cause: Cause.Cause<unknown>): Effect.Effect<void> =>
    Cause.hasDies(cause)
      ? telemetry.captureFailure({
          _tag: "Defect",
          component: "api",
          operation,
          error: "unexpected_defect",
          cause,
        })
      : Effect.void;

const makeCanonicalTelemetry = (
  telemetry: TelemetryService
): ReturnType<typeof CanonicalTelemetry.of> =>
  CanonicalTelemetry.of((httpEffect, { endpoint, group }) =>
    Effect.gen(function* () {
      const canonicalOperation = yield* Schema.decodeUnknownEffect(TelemetryCodeSchema.operation)(
        `${group.identifier}.${endpoint.identifier}`
      ).pipe(Effect.orDie);
      const catalogEntry = operationCatalog.byId.get(canonicalOperation);
      if (catalogEntry === undefined) {
        return yield* Effect.die(new Error(`Missing canonical operation: ${canonicalOperation}`));
      }
      const method = yield* Schema.decodeUnknownEffect(TelemetryHttpMethod)(
        catalogEntry.method
      ).pipe(Effect.orDie);
      const route = yield* Schema.decodeUnknownEffect(TelemetryCodeSchema.httpRoute)(
        catalogEntry.route
      ).pipe(Effect.orDie);
      const classified = Effect.tapError(httpEffect, recordExpectedOutcome(telemetry));
      const operation = telemetry.span(operationDescriptor(canonicalOperation), classified);
      const classifiedRoot = Effect.tapError(operation, recordExpectedOutcome(telemetry));
      const capturedAtHttpOwner = Effect.tapCause(
        classifiedRoot,
        captureUnexpectedDefect(telemetry, canonicalOperation)
      );
      return yield* telemetry.span(httpDescriptor({ method, route }), capturedAtHttpOwner);
    })
  );

/**
 * Supplies API-wide metadata-only tracing while preserving every observed call's success, failure,
 * interruption, and requirements unchanged.
 */
export const CanonicalTelemetryLive = Layer.effect(
  CanonicalTelemetry,
  Effect.map(Telemetry, makeCanonicalTelemetry)
);
