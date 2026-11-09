import { matchesRouteTemplate } from "../../src/shell/public-http/operations";
import { type CatalogOperation } from "../../src/shell/canonical-catalog/contract";
import { operationCatalog } from "../../src/shell/api";
import { Option } from "effect";
import { browserSessionBindingPath } from "../../src/shell/browser-transport/contract";
import { oauthPaths } from "../../src/shell/oauth-agents/contract";
import { processingConsentTransport } from "../../src/shell/processing-consent/runtime";
import { connectionBrowserTransport } from "../../src/shell/connections/runtime";
import { paymentEnrollmentTransport } from "../../src/shell/subscription/runtime";

const routes = operationCatalog.operations;
/** A public Worker path exists only when the assembled canonical HttpApi declares it. */
export const canonicalRoute = (path: string): boolean =>
  routes.some((operation) => matchesRouteTemplate({ template: operation.route, path }));
/** Allowed verbs for a declared path (including any parameter), empty for unknown paths. */
export const canonicalMethods = (path: string): ReadonlyArray<string> =>
  Array.from(
    new Set(
      routes
        .filter((operation) => matchesRouteTemplate({ template: operation.route, path }))
        .map((operation) => operation.method)
    )
  );

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
/** Select a declared operation only when verb and path template match; otherwise None. */
export const canonicalOperation = ({
  method,
  path,
}: Readonly<{ method: string; path: string }>): Option.Option<CatalogOperation> =>
  Option.fromUndefinedOr(
    routes.find(
      (operation) =>
        operation.method === method && matchesRouteTemplate({ template: operation.route, path })
    )
  );
