import { expect, it } from "@effect/vitest";
import {
  type Config,
  ConfigProvider,
  Context,
  Effect,
  Layer,
  type LogLevel,
  Logger,
  References,
  Result,
} from "effect";
import { RuntimeLoggingLive, serverConfig } from "./runtime";

const configLayer = (entries: Readonly<Record<string, string>>): Layer.Layer<never> =>
  ConfigProvider.layer(ConfigProvider.fromUnknown(entries));

type RuntimeLogging = {
  readonly loggers: ReadonlySet<Logger.Logger<unknown, unknown>>;
  readonly minimumLogLevel: LogLevel.LogLevel;
};

const loadLogging = (
  entries: Readonly<Record<string, string>>
): Effect.Effect<RuntimeLogging, Config.ConfigError> =>
  Effect.map(
    Effect.scoped(Layer.build(RuntimeLoggingLive.pipe(Layer.provide(configLayer(entries))))),
    (context) => ({
      loggers: Context.get(context, References.CurrentLoggers),
      minimumLogLevel: Context.get(context, References.MinimumLogLevel),
    })
  );

it.effect("uses one-line JSON logging in production at the configured minimum level", () =>
  Effect.gen(function* () {
    const logging = yield* loadLogging({ NODE_ENV: "production", LOG_LEVEL: "Warn" });

    expect(logging.loggers.has(Logger.consoleJson)).toBe(true);
    expect(logging.loggers.has(Logger.defaultLogger)).toBe(false);
    expect(logging.minimumLogLevel).toBe("Warn");
  })
);

it.effect("keeps readable logging in development and defaults to informational logs", () =>
  Effect.gen(function* () {
    const logging = yield* loadLogging({ NODE_ENV: "development" });

    expect(logging.loggers.has(Logger.defaultLogger)).toBe(true);
    expect(logging.loggers.has(Logger.consoleJson)).toBe(false);
    expect(logging.minimumLogLevel).toBe("Info");
  })
);

it.effect("rejects an out-of-range HTTP port as configuration failure", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      serverConfig.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ PORT: "99999" })
        )
      )
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("ConfigError");
      expect(result.failure.message).toContain("PORT");
    }
  })
);
