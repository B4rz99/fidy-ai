import { BunCrypto, BunHttpClient, BunHttpServer, BunRuntime } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { MigratorLive, PgLive, RuntimeAuthorityLive } from "~/shell/database/runtime";
import { DurableExecutionLive } from "~/shell/durable-execution";
import { AppLive } from "~/shell/http";
import { ObservabilityLive } from "~/shell/observability/runtime";
import { OutboundHttpLive } from "~/shell/outbound-http/runtime";
import { serverConfig } from "~/shell/runtime";

const ServerLive = Layer.unwrap(Effect.map(serverConfig, BunHttpServer.layer));

const MainLive = AppLive.pipe(
  Layer.provide(DurableExecutionLive),
  Layer.provide(RuntimeAuthorityLive),
  Layer.provide(MigratorLive),
  Layer.provide(ServerLive),
  Layer.provide(PgLive),
  Layer.provide(OutboundHttpLive),
  Layer.provide(BunCrypto.layer),
  Layer.provide(BunHttpClient.layer),
  Layer.provide(ObservabilityLive)
);

BunRuntime.runMain(Layer.launch(MainLive));
