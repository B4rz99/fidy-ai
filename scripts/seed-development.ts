import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, Layer, Option } from "effect";
import { MigrationPgLive, MigratorLive } from "~/shell/db/client";
import { generateDevelopmentPatBearer, seedDevelopmentIdentity } from "~/shell/db/development-seed";

const localDatabaseHosts = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const requireLocalPostgres = Effect.gen(function* () {
  const { databaseUrl, nodeEnvironment, railwayEnvironment } = yield* Config.all({
    databaseUrl: Config.url("DATABASE_URL"),
    nodeEnvironment: Config.option(Config.string("NODE_ENV")),
    railwayEnvironment: Config.option(Config.string("RAILWAY_ENVIRONMENT")),
  });
  const localPostgres =
    (databaseUrl.protocol === "postgres:" || databaseUrl.protocol === "postgresql:") &&
    localDatabaseHosts.has(databaseUrl.hostname) &&
    databaseUrl.search === "" &&
    databaseUrl.hash === "";
  const localRuntime =
    !Option.exists(nodeEnvironment, (environment) => environment === "production") &&
    Option.isNone(railwayEnvironment);

  if (!localPostgres || !localRuntime) {
    return yield* Effect.die(
      new Error("Development identity seeding requires PostgreSQL on the local machine.")
    );
  }
});

const SeedCommandLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const bearer = yield* generateDevelopmentPatBearer;
    yield* seedDevelopmentIdentity(bearer);

    // This is the command's one-time bearer-delivery channel, not application
    // logging. No logger, error, or persisted record receives the raw bearer.
    yield* Effect.sync(() => process.stdout.write(`${bearer}\n`));
  })
).pipe(
  Layer.provide(MigratorLive),
  Layer.provide(MigrationPgLive),
  Layer.provide(BunServices.layer)
);

BunRuntime.runMain(
  requireLocalPostgres.pipe(Effect.andThen(Effect.scoped(Layer.build(SeedCommandLive))))
);
