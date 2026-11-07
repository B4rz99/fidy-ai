import { FetchHttpClient, type HttpClient } from "effect/http";
import type { Layer } from "effect";
import {
  type BrowserSessionLifetime,
  bindBrowserSession,
  coordinateBrowserRequests,
} from "./session-binding";
import { type BrowserHttpBoundary, browserHttpClientLayer } from "./browser-http-policy";

export type BrowserClientOptions = Readonly<{ apiOrigin: string }> &
  (Readonly<{ session: BrowserSessionLifetime }> | Readonly<Record<never, never>>) &
  (Readonly<{ httpClient: Layer.Layer<HttpClient.HttpClient> }> | Readonly<Record<never, never>>);

/** Apply the same bounded transport and immutable session ownership to each declared browser channel. */
export const browserClientLayer = (
  options: BrowserClientOptions & Readonly<{ boundary: BrowserHttpBoundary }>
): Layer.Layer<HttpClient.HttpClient> => {
  const underlying = "httpClient" in options ? options.httpClient : FetchHttpClient.layer;
  const coordinated =
    "session" in options
      ? coordinateBrowserRequests({ transport: underlying, signal: options.session.signal })
      : underlying;
  const transport = coordinated.pipe(browserHttpClientLayer(options.boundary, options.apiOrigin));
  return !("session" in options)
    ? transport
    : bindBrowserSession({ transport, lifetime: options.session });
};
