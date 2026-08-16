import {
  FidyApi,
  type FidyApiGroups,
  TokenAuthorizationClientAnonymousLive,
} from "@fidy/server/client";
import { Layer } from "effect";
import { FetchHttpClient, type HttpClient } from "effect/unstable/http";
import { AtomHttpApi } from "effect/unstable/reactivity";

/**
 * Supplies the substitute HTTP runtime for the derived browser client. Production uses Fetch;
 * callers may provide an equivalent HttpClient layer without replacing canonical operation
 * decoding. Authentication middleware and credentialed request initialization remain internal.
 */
export type FidyClientLayer = Layer.Layer<HttpClient.HttpClient>;

const withBrowserTransportInvariants = (httpClient: FidyClientLayer): FidyClientLayer =>
  Layer.mergeAll(
    httpClient,
    Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" }),
    TokenAuthorizationClientAnonymousLive
  );

/** Layer-backed Atom client exposing every operation in the server-owned canonical API. */
export type FidyClient = AtomHttpApi.AtomHttpApiClient<
  unknown,
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
  httpClient: FidyClientLayer = FetchHttpClient.layer
): FidyClient =>
  AtomHttpApi.Service<unknown>()("@fidy/web/FidyClient", {
    api: FidyApi,
    baseUrl: apiOrigin,
    httpClient: withBrowserTransportInvariants(httpClient),
  });
