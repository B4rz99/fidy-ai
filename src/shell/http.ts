import { Layer } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { ContractGateLive } from "~/shell/_shared/errors";
import { MigratorLive } from "~/shell/db/client";
import { TransactionsLive } from "~/shell/transactions/handlers";
import { FidyApi } from "./api";

/**
 * The canonical API as live routes: every operation `FidyApi` declares, mounted
 * on the router in context with its slice's handlers and the contract gate's
 * implementation already wired in, alongside a `GET /openapi.json` serving the
 * spec derived from that same declaration — the routes a caller can reach and
 * the document describing them come from one source and cannot drift.
 *
 * The layer yields no service of its own; the registration is the whole point
 * of providing it, so its consumer is whatever builds the router around it.
 * What it still asks of the outside is the `SqlClient` the repos query through
 * and the platform services the router is built on.
 */
export const ApiLive = HttpApiBuilder.layer(FidyApi, { openapiPath: "/openapi.json" }).pipe(
  // The contract gate is provided *to* the slice layers rather than beside
  // them: a group captures its middleware from its own context when it builds
  // its routes, so a sibling layer would not be found.
  Layer.provide(TransactionsLive.pipe(Layer.provide(ContractGateLive)))
);

/**
 * Those routes bound to a socket: launching this answers them for as long as
 * the layer is alive, and logs every request it answers. It picks neither the
 * port nor the platform — both arrive with the `HttpServer` given from outside.
 */
export const HttpLive = HttpRouter.serve(ApiLive);

/**
 * The whole service, and the layer to launch. The server does not bind until
 * every pending migration has run, so no handler can meet a schema older than
 * the code querying it. What is left to supply is the environment: Postgres,
 * and a platform's HTTP server.
 */
export const AppLive = HttpLive.pipe(Layer.provide(MigratorLive));
