import { BunHttpServer, BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { PATPairingApi } from "~/pat-pairing-api";
import { PgLive, RuntimeAuthorityLive } from "~/shell/db/client";
import { PATPairingHandlersLive } from "~/shell/tokens/pairing-handlers";

// Test-only subprocess: the real bootstrap declaration, handlers, crypto, socket and restricted
// PostgreSQL pool. No migration authority, admission substitute, or control HTTP route is mounted.
const PairingServer = HttpRouter.serve(
  HttpApiBuilder.layer(PATPairingApi).pipe(Layer.provide(PATPairingHandlersLive))
).pipe(
  Layer.provide(RuntimeAuthorityLive),
  Layer.provide(PgLive),
  Layer.provideMerge(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0 })),
  Layer.provide(BunServices.layer)
);

const Ready = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer;
    if (server.address._tag !== "TcpAddress") return yield* Effect.die("Expected TCP socket");
    process.send?.({ port: server.address.port, pid: process.pid });
  })
).pipe(Layer.provide(PairingServer));

BunRuntime.runMain(Layer.launch(Ready));
