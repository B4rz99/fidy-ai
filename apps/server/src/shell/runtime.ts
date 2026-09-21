import { Config } from "effect";

const defaultHttpPort = 3000;
const oneMebibyteInBytes = 1_048_576;
/** Listener-level bound applied before request-body buffering or route decoding. */
export const maximumPublicRequestBodySizeBytes = oneMebibyteInBytes;

/**
 * Reads the process HTTP listener settings at boot: PORT defaults to 3000 and FIDY_HTTP_HOST
 * defaults to 0.0.0.0. A malformed or out-of-range PORT fails with ConfigError before binding.
 */
export const serverConfig = Config.all({
  port: Config.Port("PORT").pipe(Config.withDefault(defaultHttpPort)),
  hostname: Config.String("FIDY_HTTP_HOST").pipe(Config.withDefault("0.0.0.0")),
  maxRequestBodySize: Config.succeed(maximumPublicRequestBodySizeBytes),
});
