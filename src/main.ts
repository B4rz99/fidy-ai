import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, Layer } from "effect";
import { PgLive } from "~/shell/db/client";
import { AppLive } from "~/shell/http";

const ServerLive = Layer.unwrap(
  Effect.map(
    Config.all({
      port: Config.int("PORT").pipe(Config.withDefault(3000)),
      hostname: Config.string("FIDY_HTTP_HOST").pipe(Config.withDefault("0.0.0.0")),
    }),
    BunHttpServer.layer
  )
);

const MainLive = AppLive.pipe(
  Layer.provide(ServerLive),
  Layer.provide(PgLive),
  Layer.provide(BunServices.layer)
);

BunRuntime.runMain(Layer.launch(MainLive));
