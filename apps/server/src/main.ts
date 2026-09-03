import { BunHttpClient, BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { MigratorLive, PgLive, RuntimeAuthorityLive } from "~/shell/db/client";
import { DurableExecutionLive } from "~/shell/durable-execution";
import { AppLive } from "~/shell/http";
import { SentryLive } from "~/shell/observability/sentry-live";
import { RuntimeLoggingLive, serverConfig } from "~/shell/runtime";

const ServerLive = Layer.unwrap(Effect.map(serverConfig, BunHttpServer.layer));

const MainLive = AppLive.pipe(
  Layer.provide(DurableExecutionLive),
  Layer.provide(RuntimeAuthorityLive),
  Layer.provide(MigratorLive),
  Layer.provide(ServerLive),
  Layer.provide(PgLive),
  Layer.provide(BunHttpClient.layer),
  Layer.provide(SentryLive),
  Layer.provide(RuntimeLoggingLive)
);

BunRuntime.runMain(Layer.launch(MainLive));
