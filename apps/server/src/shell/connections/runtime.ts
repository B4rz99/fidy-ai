import { Option } from "effect";
import { ConnectionBrowserApi } from "./contract";

const transports = Object.values(ConnectionBrowserApi.groups.connectionBrowser.endpoints);

const browserHeaders = ["content-type", "cookie", "origin"] as const;

export const connectionBrowserTransport = (
  path: string
): Option.Option<{
  readonly operation: (typeof transports)[number]["identifier"];
  readonly method: (typeof transports)[number]["method"];
  readonly forwardedHeaders: typeof browserHeaders;
}> => {
  for (const endpoint of transports) {
    if (endpoint.path !== path) continue;

    return Option.some({
      operation: endpoint.identifier,
      method: endpoint.method,
      forwardedHeaders: browserHeaders,
    });
  }

  return Option.none();
};
