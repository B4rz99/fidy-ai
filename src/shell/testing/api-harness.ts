import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { ConfigProvider, Context, type Effect, Layer, type Schema } from "effect";
import { type HttpClientError } from "effect/unstable/http";
import { HttpApiClient } from "effect/unstable/httpapi";
import { type AgentBearerToken } from "~/core/tokens/model";
import { makeAgentAuthorizationClientLive } from "~/shell/_shared/authz";
import type {
  ConsentRequired,
  NotFound,
  ScopeMissing,
  Unauthenticated,
  ValidationFailed,
} from "~/shell/_shared/errors";
import { FidyApi } from "~/shell/api";
import { MigrationSqlClientLive, MigratorLive, PgLive } from "~/shell/db/client";
import { makeDevelopmentSeedLive } from "~/shell/db/development-seed";
import { defaultAgentBearer } from "./identity-fixtures";
import { HttpLive } from "~/shell/http";

/**
 * Derives the typed client from the ambient HttpClient, which the test server
 * layer points at whatever port the harness bound. Every request presents one
 * opaque AgentToken bearer; no client API accepts a UserId as authentication.
 */
const derivedApiClient = HttpApiClient.make(FidyApi);

/** The derived client's shape, for tests holding one per User rather than the service. */
export type ApiClient = Effect.Success<typeof derivedApiClient>;

/** Every declared or transport failure shared by canonical test probes. */
export type ApiCallFailure =
  | Schema.SchemaError
  | HttpClientError.HttpClientError
  | ConsentRequired
  | NotFound
  | ScopeMissing
  | Unauthenticated
  | ValidationFailed;

const TestPublicNamespace = ConfigProvider.layer(
  ConfigProvider.orElse(
    ConfigProvider.fromEnv({
      env: {
        PUBLIC_WEB_ORIGIN: "https://fidyapp.com",
        PUBLIC_API_ORIGIN: "https://api.fidyapp.com",
        INGEST_EMAIL_DOMAIN: "ingest.fidyapp.com",
      },
    }),
    ConfigProvider.fromEnv()
  )
);

/** Builds a client service whose bearer is supplied through the declared middleware. */
export const makeApiClientLive = <Id>({
  bearer,
  tag,
}: {
  readonly bearer: AgentBearerToken;
  readonly tag: Context.Key<Id, ApiClient>;
}) =>
  Layer.effect(tag, derivedApiClient).pipe(Layer.provide(makeAgentAuthorizationClientLive(bearer)));

/** The same AgentToken bearer for tests that speak raw HTTP. */
export const headersFor = (bearer: AgentBearerToken): Record<string, string> => ({
  authorization: `Bearer ${bearer}`,
});

/** The derived typed client as a service, so tests can just yield it. */
export class ApiHarnessClient extends Context.Service<ApiHarnessClient, ApiClient>()(
  "fidy-ai/shell/testing/api-harness/ApiHarnessClient"
) {}

/**
 * The API seam: the real handler stack served over a real socket against a
 * real Postgres (DATABASE_URL), exercised through the derived typed client.
 * Tests run under Bun (vitest on the Bun runtime), matching the production
 * entrypoint, so the socket is a Bun HTTP server. The layer also exposes the
 * test HttpClient, already pointed at the server, for raw HTTP checks. Runtime
 * retention workers are excluded; their deterministic seams have dedicated tests.
 */
export const ApiHarness = makeApiClientLive({
  tag: ApiHarnessClient,
  bearer: defaultAgentBearer,
}).pipe(
  Layer.provideMerge(HttpLive.pipe(Layer.provide(MigratorLive))),
  Layer.provideMerge(makeDevelopmentSeedLive(defaultAgentBearer)),
  Layer.provideMerge(BunHttpServer.layerTest),
  Layer.provideMerge(BunServices.layer),
  Layer.provideMerge(MigrationSqlClientLive),
  Layer.provideMerge(PgLive),
  Layer.provideMerge(TestPublicNamespace)
);
