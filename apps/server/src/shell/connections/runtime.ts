import { Option } from "effect";
import { ConnectionBrowserApi } from "./contract";

const transports = Object.values(ConnectionBrowserApi.groups.connectionBrowser.endpoints);
const browserHeaders = ["content-type", "cookie", "origin"] as const;

/**
 * Recognize a declared Connection browser transport independently of the request method, so a
 * wrong method remains an owned refusal. Unknown paths never acquire continuation meaning.
 *
 * Adapters enforce the declared method and exact browser origin, forward only these browser
 * headers, and retain live WebSession, Consent and atomic authority checks. Recognition supplies
 * transport meaning only; it grants neither User nor institution authority.
 */
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
