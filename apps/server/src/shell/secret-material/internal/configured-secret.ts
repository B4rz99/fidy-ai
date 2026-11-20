import { Config, ConfigProvider, Effect, type Redacted, Schema } from "effect";

const invalidSecret = (name: string, requirement: string): Config.ConfigError =>
  new Config.ConfigError(new ConfigProvider.SourceError({ message: `${name} ${requirement}` }));

export const configuredSecret = (input: {
  readonly name: string;
  readonly schema: Schema.Constraint;
  readonly requirement: string;
}): Config.Config<Redacted.Redacted<string>> =>
  Config.Redacted(input.name).pipe(
    Config.mapEffect((secret): Effect.Effect<Redacted.Redacted<string>, Config.ConfigError> =>
      Schema.is(Schema.Redacted(input.schema))(secret)
        ? Effect.succeed(secret)
        : Effect.fail(invalidSecret(input.name, input.requirement))
    )
  );
