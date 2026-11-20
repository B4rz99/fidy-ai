import { matchesRouteTemplate } from "../../src/shell/public-http/operations";
import { type CatalogOperation } from "../../src/shell/canonical-catalog/contract";
import { operationCatalog } from "../../src/shell/api";
import { Option } from "effect";

const routes = operationCatalog.operations;
const literalPaths = new Set(
  routes.filter(({ route }) => !route.includes(":")).map(({ route }) => route)
);
const parameterizedRoutes = routes.filter(({ route }) => route.includes(":"));
/** A public Worker path exists only when the assembled canonical HttpApi declares it. */
export const canonicalRoute = (path: string): boolean =>
  literalPaths.has(path) ||
  parameterizedRoutes.some((operation) =>
    matchesRouteTemplate({ template: operation.route, path })
  );
/** Allowed verbs for a declared path (including any parameter), empty for unknown paths. */
export const canonicalMethods = (path: string): ReadonlyArray<string> =>
  Array.from(
    new Set(
      routes
        .filter((operation) => matchesRouteTemplate({ template: operation.route, path }))
        .map((operation) => operation.method)
    )
  );

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
