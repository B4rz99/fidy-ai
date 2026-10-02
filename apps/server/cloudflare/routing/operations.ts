import { type CatalogOperation } from "../../src/shell/canonical-catalog/contract";
import { operationCatalog } from "../../src/shell/api";
import { Function, Option } from "effect";

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

/** Match one HttpApi route template; a parameter accepts exactly one nonempty path segment. */
export const matchesRoute = Function.dual<
  (path: string) => (template: string) => boolean,
  (template: string, path: string) => boolean
>(2, (template, path) => {
  const segments = template.split("/");
  const supplied = path.split("/");
  return (
    segments.length === supplied.length &&
    segments.every((segment, index) =>
      segment.startsWith(":") ? supplied[index] !== "" : segment === supplied[index]
    )
  );
});
