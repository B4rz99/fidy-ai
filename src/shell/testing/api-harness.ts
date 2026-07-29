import { BunHttpServer, BunServices } from "@effect/platform-bun";
import { Context, type Effect, Layer } from "effect";
import { HttpApiClient } from "effect/unstable/httpapi";
import { type AgentBearerToken } from "~/core/tokens/model";
import { makeAgentAuthorizationClientLive } from "~/shell/_shared/authz";
import { FidyApi } from "~/shell/api";
import { PgLive } from "~/shell/db/client";
import { makeDevelopmentSeedLive } from "~/shell/db/development-seed";
import { defaultAgentBearer } from "./identity-fixtures";
import { AppLive } from "~/shell/http";

/**
 * Derives the typed client from the ambient HttpClient, which the test server
 * layer points at whatever port the harness bound. Every request presents one
 * opaque AgentToken bearer; no client API accepts a UserId as authentication.
 */
const derivedApiClient = HttpApiClient.make(FidyApi);

/** The derived client's shape, for tests holding one per User rather than the service. */
export type ApiClient = Effect.Success<typeof derivedApiClient>;

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
 * test HttpClient, already pointed at the server, for raw HTTP checks.
 */
export const ApiHarness = makeApiClientLive({
  tag: ApiHarnessClient,
  bearer: defaultAgentBearer,
}).pipe(
  Layer.provideMerge(AppLive),
  Layer.provideMerge(makeDevelopmentSeedLive(defaultAgentBearer)),
  Layer.provideMerge(BunHttpServer.layerTest),
  Layer.provideMerge(BunServices.layer),
  Layer.provideMerge(PgLive)
);
