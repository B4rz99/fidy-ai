import { Config, Effect, Layer } from "effect";
import { HttpRouter, HttpServerResponse, HttpStaticServer } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";
import { AgentAuthorizationLive } from "~/shell/_shared/authz";
import { ValidationGateLive } from "~/shell/_shared/errors";
import { AuditRetentionLive } from "~/shell/audit/retention";
import { CURRENT_POLICY_PATH } from "~/shell/consent/current-disclosure";
import { PendingConsentRetentionLive } from "~/shell/consent/retention";
import { AgentService } from "~/shell/agent/agent-service";
import { OpenAiHostedInferenceLive, OpenAiLanguageModelLive } from "~/shell/agent/openai";
import { CategoriesLive } from "~/shell/categories/handlers";
import { KapsoClient } from "~/shell/channels/whatsapp/kapso-client";
import { KapsoWebhookLive } from "~/shell/channels/whatsapp/routes";
import { WhatsAppWorkerLive } from "~/shell/channels/whatsapp/worker";
import { DashboardLive } from "~/shell/dashboard/handlers";
import { MigratorLive, RuntimeAuthorityLive } from "~/shell/db/client";
import { IdentityLive } from "~/shell/identity/handlers";
import { InsightsLive } from "~/shell/insights/handlers";
import { StatementColumnMapper } from "~/shell/ingestion/column-mapper";
import { IngestionLive } from "~/shell/ingestion/handlers";
import { StatementIngestionWorkerLive } from "~/shell/ingestion/worker";
import { MemoryLive } from "~/shell/memory/handlers";
import { OperationsLive } from "~/shell/operations/handlers";
import { CanonicalTelemetryLive } from "~/shell/observability/canonical-api";
import { SubscriptionLive } from "~/shell/subscription/handlers";
import { TransactionsLive } from "~/shell/transactions/handlers";
import { FidyApi } from "./api";

/** Prevents authenticated canonical responses from remaining in caller caches. */
const CanonicalApiNoStoreLive = HttpRouter.middleware((httpEffect) =>
  Effect.map(httpEffect, (response) =>
    HttpServerResponse.setHeader(response, "cache-control", "no-store")
  )
).layer;

/**
 * The canonical API as live routes: every operation `FidyApi` declares, mounted
 * on the router in context with its slice's handlers and the validation gate's
 * implementation already integrated, alongside a `GET /openapi.json` serving the
 * spec derived from that same declaration — the routes a caller can reach and
 * the document describing them come from one source and cannot drift.
 *
 * The layer yields no service of its own; the registration is the whole point
 * of providing it, so its consumer is whatever builds the router around it.
 * What it still asks of the outside is the `SqlClient` the repos query through
 * and the platform services the router is built on.
 */
export const ApiLive = HttpApiBuilder.layer(FidyApi, { openapiPath: "/openapi.json" }).pipe(
  Layer.provide(CanonicalApiNoStoreLive),
  // The validation gate is provided *to* the slice layers rather than beside
  // them: a group captures its middleware from its own context when it builds
  // its routes, so a sibling layer would not be found.
  Layer.provide(
    Layer.mergeAll(
      IdentityLive,
      CategoriesLive,
      DashboardLive,
      TransactionsLive,
      IngestionLive,
      InsightsLive,
      MemoryLive,
      SubscriptionLive,
      OperationsLive
    ).pipe(Layer.provide([ValidationGateLive, AgentAuthorizationLive, CanonicalTelemetryLive]))
  )
);

const appVersion = Config.string("APP_VERSION").pipe(
  Config.orElse(() => Config.string("RAILWAY_DEPLOYMENT_ID")),
  Config.withDefault("development")
);

const HealthLive = Layer.unwrap(
  Effect.map(appVersion, (version) =>
    HttpRouter.add("GET", "/health", HttpServerResponse.json({ status: "ok", version }))
  )
);

const PolicyLive = HttpRouter.add("GET", "/politica", HttpServerResponse.file(CURRENT_POLICY_PATH));

const StaticLive = HttpStaticServer.layer({ root: "public", spa: true });

/**
 * The public HTTP surface bound to a socket: the canonical API and OpenAPI
 * document, unauthenticated health/version information, and the static SPA
 * shell. Launching this answers for as long as the layer is alive and logs
 * every request. The port and platform arrive from the outside.
 */
export const HttpLive = HttpRouter.serve(
  Layer.mergeAll(
    ApiLive,
    HttpApiScalar.layer(FidyApi, { path: "/docs" }),
    HealthLive,
    PolicyLive,
    StaticLive,
    KapsoWebhookLive
  )
);

/**
 * The whole service, and the layer to launch. The server and retention workers
 * do not start until every pending migration has run, so none can meet a schema
 * older than the code querying it. What is left to
 * supply is the environment: Postgres, an HTTP server, and the platform file,
 * path, and HTTP services used to serve the static shell.
 */
const HostedWhatsAppWorkerLive = WhatsAppWorkerLive.pipe(
  Layer.provide(AgentService.layer),
  Layer.provide(KapsoClient.layer)
);

const HostedStatementIngestionWorkerLive = StatementIngestionWorkerLive.pipe(
  Layer.provide(StatementColumnMapper.layer.pipe(Layer.provide(OpenAiLanguageModelLive)))
);

export const AppLive = Layer.mergeAll(
  HttpLive.pipe(Layer.provide(KapsoClient.layer)),
  HostedWhatsAppWorkerLive,
  HostedStatementIngestionWorkerLive,
  AuditRetentionLive,
  PendingConsentRetentionLive
).pipe(
  Layer.provide(OpenAiHostedInferenceLive),
  Layer.provide(RuntimeAuthorityLive),
  Layer.provide(MigratorLive)
);
