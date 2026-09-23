import { type CatalogOperation, operationCatalog } from "@fidy/server/canonical-runtime";
import { Option } from "effect";
import { matchesRoute } from "./route-match";

const routes = operationCatalog.operations;
/** A public Worker path exists only when the assembled canonical HttpApi declares it. */
export const canonicalRoute = (path: string): boolean =>
  routes.some((operation) => matchesRoute(operation.route, path));
/** Allowed verbs for a declared path (including any parameter), empty for unknown paths. */
export const canonicalMethods = (path: string): ReadonlyArray<string> =>
  Array.from(
    new Set(
      routes
        .filter((operation) => matchesRoute(operation.route, path))
        .map((operation) => operation.method)
    )
  );
/** Select a declared operation only when verb and path template match; otherwise None. */
export const canonicalOperation = ({
  method,
  path,
}: Readonly<{ method: string; path: string }>): Option.Option<CatalogOperation> =>
  Option.fromUndefinedOr(
    routes.find((operation) => operation.method === method && matchesRoute(operation.route, path))
  );
