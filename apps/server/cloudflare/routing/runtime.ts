import { Option } from "effect";
import { canonicalOperation } from "./operations";
import { browserSessionBindingPath } from "../../src/shell/browser-transport/contract";
import { oauthPaths } from "../../src/shell/oauth-agents/contract";
import { processingConsentTransport } from "../../src/shell/processing-consent/runtime";
import { connectionBrowserTransport } from "../../src/shell/connections/runtime";
import { paymentEnrollmentTransport } from "../../src/shell/subscription/runtime";

/** Reuse existing read declarations; this changes execution placement, never query ownership. */
export const sharedStorageRead = (request: Pick<Request, "method" | "url">): boolean => {
  if (request.method !== "GET") return false;
  const path = new URL(request.url).pathname;
  return (
    Option.exists(
      canonicalOperation({ method: request.method, path }),
      (operation) => operation.policy.kind === "query"
    ) ||
    path === browserSessionBindingPath ||
    path === oauthPaths.connections ||
    Option.exists(processingConsentTransport(path), (transport) => transport.method === "GET") ||
    Option.exists(connectionBrowserTransport(path), (transport) => transport.method === "GET") ||
    Option.exists(paymentEnrollmentTransport(path), (transport) => transport.method === "GET")
  );
};
