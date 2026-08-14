import { Cause, Clock, Effect, Layer, Option, Schema } from "effect";
import { HttpServerRequest } from "effect/unstable/http";
import { CanonicalTelemetry } from "~/shell/_shared/canonical-telemetry";
import { operationCatalog } from "~/shell/api";
import {
  type DeclaredOutcome,
  type SpanDescriptor,
  TelemetryHttpMethod,
  type TelemetryHttpMethod as TelemetryHttpMethodType,
} from "./protocol";
import { type TelemetryCode, TelemetryCodeSchema } from "./registry";
import { Telemetry, type TelemetryService, decodeTraceParent } from "./telemetry";

const ExpectedFailure = Schema.Struct({
  error: Schema.Struct({ code: TelemetryCodeSchema.error }),
});

const expectedOutcome = (failure: unknown): Option.Option<DeclaredOutcome> =>
  Option.map(Schema.decodeUnknownOption(ExpectedFailure)(failure), ({ error }) => ({
    outcome: "rejected",
    error: Option.some(error.code),
    retryable: false,
  }));

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
      const descriptor = httpDescriptor({ method, route });
      const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest);
      const receivedAt = yield* Clock.currentTimeMillis;
      const continued = Option.flatMap(request, ({ headers }) =>
        decodeTraceParent({
          value: Option.fromUndefinedOr(headers.traceparent),
          receivedAtUnixMilliseconds: receivedAt,
        })
      );
      const hostedTurnContext = yield* Option.match(continued, {
        onNone: () => Effect.succeed(Option.none()),
        onSome: (context) =>
          Effect.map(telemetry.isActiveSpan(context, "agent.hostedTurn"), (isActive) =>
            isActive ? Option.some(context) : Option.none()
          ),
      });
      const ownedWork = Option.isSome(hostedTurnContext)
        ? classifiedRoot
        : Effect.tapCause(classifiedRoot, captureUnexpectedDefect(telemetry, canonicalOperation));
      return yield* Option.match(hostedTurnContext, {
        onNone: () => telemetry.span(descriptor, ownedWork),
        onSome: (context) => telemetry.continueSpan(context, descriptor, ownedWork),
      });
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
