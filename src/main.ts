import { BunHttpClient, BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer, Option } from "effect";
import { CanonicalApiBaseUrl, CanonicalApiUrl } from "~/shell/agent/toolkit";
import { PgLive } from "~/shell/db/client";
import { AppLive } from "~/shell/http";
import { SentryLive } from "~/shell/observability/sentry-live";
import { RuntimeLoggingLive, serverConfig } from "~/shell/runtime";

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
  Layer.provide(SentryLive),
  Layer.provide(RuntimeLoggingLive)
);

BunRuntime.runMain(Layer.launch(MainLive));
