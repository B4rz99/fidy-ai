import {
  BrowserLoginPairingInvalidApi,
  BrowserLoginPollingRateLimitedApi,
  FidyApi,
  type FidyApiGroups,
  PriceRevisionId,
  TokenAuthorizationClientAnonymousLive,
  WebAuthApi,
  type WebAuthApiGroups,
} from "@fidy/server/client";
import { Effect, Layer, Schema } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";
import { AtomHttpApi } from "effect/unstable/reactivity";

export type { CanonicalSuccess } from "@fidy/server/client";
export { BrowserLoginPairingInvalidApi, BrowserLoginPollingRateLimitedApi, PriceRevisionId };

/**
 * Supplies the substitute HTTP runtime for the derived browser client. Production uses Fetch;
 * callers may provide an equivalent HttpClient layer without replacing canonical operation
 * decoding. Authentication middleware and credentialed request initialization remain internal.
 */
export type FidyClientLayer = Layer.Layer<HttpClient.HttpClient>;

const withCredentials = (httpClient: FidyClientLayer): FidyClientLayer =>
  httpClient.pipe(
    Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" }))
  );

const withBrowserTransportInvariants = (httpClient: FidyClientLayer): FidyClientLayer =>
  Layer.merge(withCredentials(httpClient), TokenAuthorizationClientAnonymousLive);

/** Receives the single browser-lifetime transition caused by a canonical 401 response. */
export type CanonicalAuthenticationObserver = Readonly<{
  onAuthenticationExpired: () => void;
}>;

const UnauthenticatedResponse = Schema.Struct({
  error: Schema.Struct({ code: Schema.Literal("unauthenticated") }),
});

const observeAuthenticationExpiration =
  (observer?: CanonicalAuthenticationObserver) =>
  <A, E, R>(response: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.tapError(response, (error) =>
      observer !== undefined && Schema.is(UnauthenticatedResponse)(error)
        ? Effect.sync(observer.onAuthenticationExpired)
        : Effect.void
    );

export type FidyClient = AtomHttpApi.AtomHttpApiClient<
  never,
  "@fidy/web/FidyClient",
  FidyApiGroups
>;

/**
 * Derives the sole browser transport from the server-owned canonical API declaration. `apiOrigin`
 * must be a credential-free HTTP(S) origin already validated by `parseApiOrigin`; it is used as the
 * request base URL without further normalization. Production callers use credentialed Fetch; tests
 * may replace only the underlying HttpClient layer while keeping this same derived typed client and
 * canonical request decoding.
 */
export const makeFidyClient = (
  apiOrigin: string,
  httpClient: FidyClientLayer = FetchHttpClient.layer,
  observer?: CanonicalAuthenticationObserver
): FidyClient =>
  AtomHttpApi.Service<never>()("@fidy/web/FidyClient", {
    api: FidyApi,
    baseUrl: apiOrigin,
    httpClient: withBrowserTransportInvariants(httpClient),
    transformResponse: observeAuthenticationExpiration(observer),
  });

/** Direct authentication transport, separate from product operations because it carries proofs. */
export type WebAuthClient = AtomHttpApi.AtomHttpApiClient<
  never,
  "@fidy/web/WebAuthClient",
  WebAuthApiGroups
>;

/** Derives browser authentication calls from the server declaration over the same Fetch runtime. */
export const makeWebAuthClient = (
  apiOrigin: string,
  httpClient: FidyClientLayer = FetchHttpClient.layer
): WebAuthClient =>
  AtomHttpApi.Service<never>()("@fidy/web/WebAuthClient", {
    api: WebAuthApi,
    baseUrl: apiOrigin,
    httpClient: withCredentials(httpClient),
  });
