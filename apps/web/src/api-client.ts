import { FidyApi, TokenAuthorizationClientAnonymousLive } from "@fidy/server/client";
import { Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { AtomHttpApi } from "effect/unstable/reactivity";

const browserHttpClientLive = Layer.mergeAll(
  FetchHttpClient.layer,
  Layer.succeed(FetchHttpClient.RequestInit, { credentials: "include" }),
  TokenAuthorizationClientAnonymousLive
);

/**
 * Derives the sole browser transport from the server-owned canonical API
 * declaration. `apiOrigin` must already be a validated HTTP(S) origin. The
 * resulting service sends credentialed Fetch requests and supplies anonymous
 * authorization until a caller token is available.
 */
export const makeFidyClient = (apiOrigin: string) =>
  AtomHttpApi.Service()("@fidy/web/FidyClient", {
    api: FidyApi,
    baseUrl: apiOrigin,
    httpClient: browserHttpClientLive,
  });

/** The Layer-backed AtomHttpApi service consumed by application providers. */
export type FidyClient = ReturnType<typeof makeFidyClient>;
