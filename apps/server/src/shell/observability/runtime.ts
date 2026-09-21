import { Cause, Config, Effect, Layer, Logger, Option, References, Schema } from "effect";
import { CanonicalTelemetry } from "~/shell/_shared/canonical-telemetry";
import { operationCatalog } from "~/shell/api";
import {
  type SpanDescriptor,
  type TelemetryCode,
  TelemetryCodeSchema,
  TelemetryHttpMethod,
  type TelemetryHttpMethod as TelemetryHttpMethodType,
  type TelemetryService,
} from "./contract";
import {
  renderSentryVerificationReport,
  verifySentryAccount as verifySentryAccountInternal,
} from "~/shell/observability/internal/account-policy";
import {
  inspectSentryAccount,
  sentryAccountConfig,
  unavailableSentryAccountObservation,
} from "~/shell/observability/internal/sentry-account-reader";
import { makeSentryTelemetry as makeSentryTelemetryInternal } from "~/shell/observability/internal/sentry-adapter";
import { getTelemetryBootstrap as getTelemetryBootstrapInternal } from "~/shell/observability/internal/telemetry-bootstrap";
import { prepareSentryRelease as prepareSentryReleaseInternal } from "~/shell/observability/internal/release-preparation";
import { decodeSentryAccountSmokeConfig } from "~/shell/observability/internal/telemetry-config";
import {
  Telemetry,
  makeTelemetryService,
  operationDescriptor,
  recordExpectedOutcome,
} from "./operations";

/**
 * Runtime Telemetry layer backed exclusively by the preload handoff. Missing preload fails runtime
 * assembly rather than constructing a second, late exporter client.
 */
export const SentryLive = Telemetry.layer(
  Effect.flatMap(Effect.sync(getTelemetryBootstrapInternal), Effect.fromResult).pipe(
    Effect.map((bootstrap) => bootstrap.resource)
  )
);

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
      const route = yield* Schema.decodeEffect(TelemetryCodeSchema.httpRoute)(
        catalogEntry.route
      ).pipe(Effect.orDie);
      const classified = Effect.tapError(httpEffect, recordExpectedOutcome(telemetry));
      const operation = telemetry.span(operationDescriptor(canonicalOperation), classified);
      const classifiedRoot = Effect.tapError(operation, recordExpectedOutcome(telemetry));
      return yield* telemetry.span(
        httpDescriptor({ method, route }),
        Effect.tapCause(classifiedRoot, captureUnexpectedDefect(telemetry, canonicalOperation))
      );
    })
  );

/** API-wide metadata-only tracing that preserves every observed call's complete exit. */
export const CanonicalTelemetryLive = Layer.effect(
  CanonicalTelemetry,
  Effect.map(Telemetry, makeCanonicalTelemetry)
);

const sentrySmokeIdentity = Config.all({
  dsn: Config.Redacted("SENTRY_NON_PRODUCTION_DSN"),
  release: Config.String("SENTRY_RELEASE"),
  environment: Config.Literals(["local", "ci"], "SENTRY_ENVIRONMENT"),
});

/** Networked exporter runtime for the bounded operator-only account smoke command. */
export const SentryAccountSmokeLive = Layer.effect(
  Telemetry,
  Effect.gen(function* () {
    const identity = yield* sentrySmokeIdentity;
    const config = yield* decodeSentryAccountSmokeConfig(identity);
    const telemetry = yield* Effect.acquireRelease(
      Effect.sync(() => makeSentryTelemetryInternal(config)),
      (value) => value.resource.close
    );
    return makeTelemetryService(telemetry.resource.adapter);
  })
);

/** Sends one harmless defect through the production metadata-only projection. */
export const recordSentryAccountSmoke = (telemetry: TelemetryService): Effect.Effect<void> =>
  telemetry.captureFailure({
    _tag: "Defect",
    component: "ci",
    operation: "observability.accountSmoke",
    error: "unexpected_defect",
    cause: new Error("Sentry account smoke check"),
  });

const LoggerLive = Layer.unwrap(
  Effect.map(Config.String("NODE_ENV").pipe(Config.withDefault("development")), (environment) =>
    environment === "production"
      ? Logger.layer([Logger.consoleJson])
      : Logger.layer([Logger.defaultLogger])
  )
);

const MinimumLogLevelLive = Layer.unwrap(
  Effect.map(Config.LogLevel("LOG_LEVEL").pipe(Config.withDefault("Info")), (minimumLogLevel) =>
    Layer.succeed(References.MinimumLogLevel, minimumLogLevel)
  )
);

/** Installs process-wide log rendering and filtering from validated runtime configuration. */
export const RuntimeLoggingLive = Layer.mergeAll(LoggerLive, MinimumLogLevelLive);

/** Prepares the immutable exporter release and source maps for the current production build. */
export const prepareSentryRelease = (): Promise<string> => prepareSentryReleaseInternal();

/** Reads and verifies the configured exporter account, returning only the bounded report text. */
export const verifySentryAccountConfiguration = Effect.gen(function* () {
  const config = yield* sentryAccountConfig;
  const observation = yield* inspectSentryAccount(config).pipe(
    Effect.catchTag("SentryAccountReadError", () =>
      Effect.succeed(unavailableSentryAccountObservation)
    )
  );
  return renderSentryVerificationReport(verifySentryAccountInternal({ observation }));
});

/** Production Observability runtime, including exporter lifecycle and safe log rendering. */
export const ObservabilityLive = Layer.merge(SentryLive, RuntimeLoggingLive);
