import { BunHttpClient, BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import { Config, Effect, Layer, Option } from "effect";
import { CanonicalApiBaseUrl, CanonicalApiUrl } from "~/shell/agent/toolkit";
import { PgLive } from "~/shell/db/client";
import { AppLive } from "~/shell/http";

const defaultHttpPort = 3000;

const serverConfig = Config.all({
  port: Config.int("PORT").pipe(Config.withDefault(defaultHttpPort)),
  hostname: Config.string("FIDY_HTTP_HOST").pipe(Config.withDefault("0.0.0.0")),
});

const ServerLive = Layer.unwrap(Effect.map(serverConfig, BunHttpServer.layer));

const CanonicalApiUrlLive = Layer.effect(
  CanonicalApiBaseUrl,
  Effect.map(serverConfig, ({ port }) =>
    Option.some(CanonicalApiUrl.make(new URL(`http://127.0.0.1:${port}/`)))
  )
);

const MainLive = AppLive.pipe(
  Layer.provide(ServerLive),
  Layer.provide(CanonicalApiUrlLive),
  Layer.provide(PgLive),
  Layer.provide(BunHttpClient.layer),
  Layer.provide(BunServices.layer)
);

BunRuntime.runMain(Layer.launch(MainLive));
