import {
  FidyApi,
  type FidyApiGroups,
  TokenAuthorizationClientAnonymousLive,
} from "@fidy/server/client";
import { Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { AtomHttpApi } from "effect/unstable/reactivity";

const browserHttpClientLive = Layer.mergeAll(
  FetchHttpClient.layer,
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
 * must already be a validated HTTP(S) origin. The resulting client sends credentialed Fetch
 * requests and supplies anonymous authorization until a caller token is available.
 */
export const makeFidyClient = (apiOrigin: string): FidyClient =>
  AtomHttpApi.Service<unknown>()("@fidy/web/FidyClient", {
    api: FidyApi,
    baseUrl: apiOrigin,
    httpClient: browserHttpClientLive,
  });
