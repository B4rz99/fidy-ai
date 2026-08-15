import { Config, Effect, Layer, Logger, References } from "effect";

const defaultHttpPort = 3000;

/**
 * Reads the process HTTP listener settings at boot: PORT defaults to 3000 and FIDY_HTTP_HOST
 * defaults to 0.0.0.0. A malformed or out-of-range PORT fails with ConfigError before binding.
 */
export const serverConfig = Config.all({
  port: Config.port("PORT").pipe(Config.withDefault(defaultHttpPort)),
  hostname: Config.string("FIDY_HTTP_HOST").pipe(Config.withDefault("0.0.0.0")),
});

const LoggerLive = Layer.unwrap(
  Effect.map(Config.string("NODE_ENV").pipe(Config.withDefault("development")), (environment) =>
    environment === "production"
      ? Logger.layer([Logger.consoleJson])
      : Logger.layer([Logger.defaultLogger])
  )
);

const MinimumLogLevelLive = Layer.unwrap(
  Effect.map(Config.logLevel("LOG_LEVEL").pipe(Config.withDefault("Info")), (minimumLogLevel) =>
    Layer.succeed(References.MinimumLogLevel, minimumLogLevel)
  )
);

/**
 * Installs process-wide log rendering and filtering. NODE_ENV=production emits one JSON object per
 * entry; every other value uses Effect's readable logger. LOG_LEVEL defaults to Info, and an
 * unrecognized configured level fails layer construction with ConfigError.
 */
export const RuntimeLoggingLive = Layer.mergeAll(LoggerLive, MinimumLogLevelLive);
