import { Config, Effect, Layer } from "effect";
import { makeSentryTelemetry } from "./sentry-adapter";
import { Telemetry, type TelemetryService, makeTelemetryService } from "./telemetry";
import { decodeSentryAccountSmokeConfig } from "./telemetry-config";

const makeSmokeCause = (): Error => new Error("Sentry account smoke check");

const sentrySmokeIdentity = Config.all({
  dsn: Config.redacted("SENTRY_NON_PRODUCTION_DSN"),
  release: Config.string("SENTRY_RELEASE"),
  environment: Config.literals(["local", "ci"], "SENTRY_ENVIRONMENT"),
});

/**
 * Networked Sentry telemetry for the bounded operator-only smoke command. Construction requires
 * `SENTRY_NON_PRODUCTION_DSN`, `SENTRY_RELEASE`, and `SENTRY_ENVIRONMENT`; layer finalization drains
 * accepted work.
 */
export const SentryAccountSmokeLive = Layer.effect(
  Telemetry,
  Effect.gen(function* () {
    const identity = yield* sentrySmokeIdentity;
    const config = yield* decodeSentryAccountSmokeConfig(identity);
    const telemetry = yield* Effect.acquireRelease(
      Effect.sync(() => makeSentryTelemetry(config)),
      (value) => value.resource.close
    );
    return makeTelemetryService(telemetry.resource.adapter);
  })
);

/** Sends one harmless defect through the same metadata-only projection used by production. */
export const recordSentryAccountSmoke = (telemetry: TelemetryService): Effect.Effect<void> =>
  telemetry.captureFailure({
    _tag: "Defect",
    component: "ci",
    operation: "observability.accountSmoke",
    error: "unexpected_defect",
    cause: makeSmokeCause(),
  });
