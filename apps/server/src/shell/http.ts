import { Config, Effect, Layer, Option, Schema } from "effect";
import { HttpRouter, type HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";
import { TokenAuthorizationLive } from "~/shell/_shared/authz-live";
import { makeExactOriginCors } from "~/shell/_shared/exact-origin-cors";
import { ValidationGateLive } from "~/shell/_shared/errors-live";
import { CanonicalRetryAfterBody } from "~/shell/_shared/errors";
import { externalEndpoints } from "~/shell/_shared/external-endpoints";
import { EvidenceRetentionLive } from "./evidence-retention";
import { OnboardingRetentionLive } from "~/shell/onboarding/retention";
import { AgentService } from "~/shell/agent/agent-service";
import { OpenAiHostedInferenceLive, OpenAiLanguageModelLive } from "~/shell/agent/openai";
import {
  BrowserLoginEvidenceRetentionLive,
  BrowserLoginLive,
  BrowserLoginWebAuthHandlersLive,
} from "~/shell/browser-login/handlers";
import { BudgetsLive } from "~/shell/budgets/handlers";
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
import { EmailDeliveryPort } from "~/shell/email-authentication/delivery";
import { BrowserPairingEmailDeliveryWorkerLive } from "~/shell/email-authentication/authentication-delivery-worker";
import { BrowserPairingEmailAuthenticationWebAuthHandlersLive } from "~/shell/email-authentication/authentication-handlers";
import { BrowserPairingEmailRetentionLive } from "~/shell/email-authentication/authentication-retention";
import {
  EmailOnboardingWebAuthHandlersLive,
  EmailReplacementWebAuthHandlersLive,
} from "~/shell/email-authentication/handlers";
import { EmailAuthenticationLive } from "~/shell/email-authentication/replacement-handlers";
import { EmailReplacementDeliveryWorkerLive } from "~/shell/email-authentication/replacement-delivery-worker";
import { EmailReplacementRetentionLive } from "~/shell/email-authentication/replacement-retention";
import { OnboardingDeliveryWorkerLive } from "~/shell/onboarding/delivery-worker";
import { OperationsLive } from "~/shell/operations/handlers";
import { CanonicalTelemetryLive } from "~/shell/observability/canonical-api";
import { SubscriptionLive } from "~/shell/subscription/handlers";
import { PATsLive } from "~/shell/tokens/handlers";
import { PATPairingHandlersLive } from "~/shell/tokens/pairing-handlers";
import { PATPairingExpiryWorkerLive } from "~/shell/tokens/pairing-expiry";
import { PATPairingApi } from "~/pat-pairing-api";
import { TransactionsLive } from "~/shell/transactions/handlers";
import { WebAuthApi, browserPairingEmailAuthenticationInvalidBody } from "~/web-auth-api";
import { FidyApi, operationCatalog } from "./api";

/** Prevents authenticated canonical responses from remaining in caller caches. */
const CanonicalApiNoStoreLive = HttpRouter.middleware((httpEffect) =>
  Effect.map(httpEffect, (response) =>
    HttpServerResponse.setHeader(response, "cache-control", "no-store")
  )
).layer;

const WebAuthNoStoreLive = HttpRouter.middleware((httpEffect) =>
  Effect.map(httpEffect, (response) =>
    HttpServerResponse.setHeader(response, "cache-control", "no-store")
  )
).layer;

const WebAuthLive = HttpApiBuilder.layer(WebAuthApi).pipe(
  Layer.provide(WebAuthNoStoreLive),
  Layer.provide(
    Layer.mergeAll(
      BrowserLoginWebAuthHandlersLive,
      BrowserPairingEmailAuthenticationWebAuthHandlersLive,
      EmailOnboardingWebAuthHandlersLive,
      EmailReplacementWebAuthHandlersLive
    )
  )
);

const PATPairingDirectLive = HttpApiBuilder.layer(PATPairingApi).pipe(
  Layer.provide(WebAuthNoStoreLive),
  Layer.provide(PATPairingHandlersLive)
);

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
      BrowserLoginLive,
      IdentityLive,
      CategoriesLive,
      BudgetsLive,
      DashboardLive,
      EmailAuthenticationLive,
      TransactionsLive,
      IngestionLive,
      InsightsLive,
      MemoryLive,
      SubscriptionLive,
      PATsLive,
      OperationsLive
    ).pipe(Layer.provide([ValidationGateLive, TokenAuthorizationLive, CanonicalTelemetryLive]))
  )
);

declare const FIDY_CONTRACT_DIGEST: string;

const ProductionGitRevision = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}$/u));
const gitRevision = Effect.gen(function* () {
  const environment = yield* Config.string("NODE_ENV").pipe(Config.withDefault("development"));
  if (environment === "production") {
    return yield* Config.schema(ProductionGitRevision, "RAILWAY_GIT_COMMIT_SHA");
  }
  return yield* Config.string("RAILWAY_GIT_COMMIT_SHA").pipe(Config.withDefault("development"));
});
const contractDigest =
  typeof FIDY_CONTRACT_DIGEST === "undefined" ? "development" : FIDY_CONTRACT_DIGEST;

const HealthLive = Layer.unwrap(
  Effect.map(gitRevision, (revision) =>
    HttpRouter.add(
      "GET",
      "/health",
      HttpServerResponse.json({ status: "ok", gitRevision: revision, contractDigest })
    )
  )
);

const canonicalCorsMethods = Array.from(
  new Set(operationCatalog.operations.map(({ method }) => method))
).sort();

/**
 * Registers the global exact-origin boundary after parsing the required public
 * namespace. Missing or malformed origin configuration fails Layer startup,
 * before the router can serve any canonical or callback behavior.
 */
const tooManyRequestsStatus = 429;

type RetryAfterHeader = <E, R>(
  httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  E,
  R | HttpServerRequest.HttpServerRequest
>;

/** Adds the standard HTTP delay header to every typed 429 carrying an exact retry interval. */
const addRetryAfterHeader: RetryAfterHeader = (httpEffect) =>
  Effect.map(httpEffect, (response) => {
    if (response.status !== tooManyRequestsStatus || response.body._tag !== "Uint8Array") {
      return response;
    }
    const decoded = Schema.decodeUnknownOption(Schema.fromJsonString(CanonicalRetryAfterBody))(
      new TextDecoder().decode(response.body.body)
    );
    return Option.match(decoded, {
      onNone: () => response,
      onSome: ({ error }) =>
        HttpServerResponse.setHeader(response, "retry-after", String(error.retryAfterSeconds)),
    });
  });
const RetryAfterHeaderLive = HttpRouter.middleware(addRetryAfterHeader, { global: true });

const browserPairingEmailPaths = new Set([
  "/web/email/authentication/start",
  "/web/email/authentication/complete",
]);
const emailAuthenticationForbidden = (
  request: HttpServerRequest.HttpServerRequest
): HttpServerResponse.HttpServerResponse =>
  browserPairingEmailPaths.has(new URL(request.url, "http://localhost").pathname)
    ? HttpServerResponse.jsonUnsafe(browserPairingEmailAuthenticationInvalidBody, {
        status: 403,
        headers: { "cache-control": "no-store", vary: "Origin" },
      })
    : HttpServerResponse.empty({
        status: 403,
        headers: { "cache-control": "no-store", vary: "Origin" },
      });

export const ExactOriginCorsLive = Layer.unwrap(
  Effect.map(externalEndpoints, ({ webOrigin }) =>
    HttpRouter.middleware(
      makeExactOriginCors({
        allowedOrigin: webOrigin,
        methods: canonicalCorsMethods,
        forbiddenResponse: Option.some(emailAuthenticationForbidden),
      }),
      {
        global: true,
      }
    )
  )
);

/**
 * The public HTTP surface bound to a socket: the canonical API and OpenAPI
 * document, unauthenticated health/version information, provider callbacks,
 * and an exact-origin browser boundary. Web routes and static assets belong to
 * the separate web application. The port and platform arrive from the outside.
 */
export const HttpLive = HttpRouter.serve(
  Layer.mergeAll(
    ApiLive,
    WebAuthLive,
    PATPairingDirectLive,
    BrowserLoginEvidenceRetentionLive,
    HttpApiScalar.layer(FidyApi, { path: "/docs" }),
    HealthLive,
    KapsoWebhookLive,
    ExactOriginCorsLive,
    RetryAfterHeaderLive
  )
);

/**
 * The whole service, and the layer to launch. The server and retention workers
 * do not start until every pending migration has run, so none can meet a schema
 * older than the code querying it. What is left to
 * supply is the environment: Postgres, an HTTP server, and the platform services
 * used by the canonical API and provider callbacks.
 */
const HostedWhatsAppWorkerLive = WhatsAppWorkerLive.pipe(
  Layer.provide(AgentService.layer),
  Layer.provide(KapsoClient.layer)
);

const HostedStatementIngestionWorkerLive = StatementIngestionWorkerLive.pipe(
  Layer.provide(StatementColumnMapper.layer.pipe(Layer.provide(OpenAiLanguageModelLive)))
);

const HostedOnboardingDeliveryWorkerLive = OnboardingDeliveryWorkerLive.pipe(
  Layer.provide(EmailDeliveryPort.layer)
);
const HostedEmailReplacementDeliveryWorkerLive = EmailReplacementDeliveryWorkerLive.pipe(
  Layer.provide(EmailDeliveryPort.layer)
);
const HostedBrowserPairingEmailDeliveryWorkerLive = BrowserPairingEmailDeliveryWorkerLive.pipe(
  Layer.provide(EmailDeliveryPort.layer)
);

export const AppLive = Layer.mergeAll(
  HttpLive.pipe(Layer.provide(KapsoClient.layer)),
  HostedWhatsAppWorkerLive,
  HostedStatementIngestionWorkerLive,
  HostedOnboardingDeliveryWorkerLive,
  HostedEmailReplacementDeliveryWorkerLive,
  HostedBrowserPairingEmailDeliveryWorkerLive,
  BrowserPairingEmailRetentionLive,
  EmailReplacementRetentionLive,
  EvidenceRetentionLive,
  OnboardingRetentionLive,
  PATPairingExpiryWorkerLive
).pipe(
  Layer.provide(OpenAiHostedInferenceLive),
  Layer.provide(RuntimeAuthorityLive),
  Layer.provide(MigratorLive)
);
