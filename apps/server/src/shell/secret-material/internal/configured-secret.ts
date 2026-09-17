import { Config, ConfigProvider, Effect, type Redacted, Schema } from "effect";

const invalidSecret = (name: string, requirement: string): Config.ConfigError =>
  new Config.ConfigError(new ConfigProvider.SourceError({ message: `${name} ${requirement}` }));

/**
 * Reads a Secret from configuration and proves it against `schema` while it stays inside its
 * `Redacted` wrapper. The proof runs on the wrapped value, so a rejected candidate cannot reach a
 * configuration or Schema error: a malformed Secret fails with a fixed diagnostic naming only the
 * variable and requirement, and a valid one keeps the wrapper for its owning adapter.
 */
export const configuredSecret = (input: {
  readonly name: string;
  readonly schema: Schema.Constraint;
  readonly requirement: string;
}): Config.Config<Redacted.Redacted<string>> =>
  Config.redacted(input.name).pipe(
    Config.mapOrFail((secret): Effect.Effect<Redacted.Redacted<string>, Config.ConfigError> =>
      Schema.is(Schema.Redacted(input.schema))(secret)
        ? Effect.succeed(secret)
        : Effect.fail(invalidSecret(input.name, input.requirement))
    )
  );
