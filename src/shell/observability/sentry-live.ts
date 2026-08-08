import { Config, Effect, Redacted } from "effect";
import { makeSentryTelemetry } from "./sentry-adapter";
import { Telemetry } from "./telemetry";

const sentryConfig = Config.all({
  dsn: Config.redacted("SENTRY_DSN"),
  release: Config.string("SENTRY_RELEASE"),
  environment: Config.string("SENTRY_ENVIRONMENT"),
});

/**
 * Configured Sentry integration for the Telemetry service. It requires SENTRY_DSN, SENTRY_RELEASE,
 * and SENTRY_ENVIRONMENT, fails layer construction when any are absent, sends only projected
 * metadata-safe envelopes over the network, and drains accepted envelopes during layer shutdown.
 */
export const SentryLive = Telemetry.layer(
  Effect.gen(function* () {
    const config = yield* sentryConfig;
    return makeSentryTelemetry({
      dsn: Redacted.value(config.dsn),
      release: config.release,
      environment: config.environment,
    });
  })
);
