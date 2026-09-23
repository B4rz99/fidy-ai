import { Option } from "effect";
import { operationCatalog } from "~/shell/api";
import type { CatalogOperation } from "~/shell/_shared/operation-catalog";

const matches = (template: string, path: string): boolean => {
  const expected = template.split("/");
  const actual = path.split("/");
  return (
    expected.length === actual.length &&
    expected.every((segment, index) =>
      segment.startsWith(":") ? (actual[index]?.length ?? 0) > 0 : segment === actual[index]
    )
  );
};

const implemented = [
  "transactions.createTransaction",
  "transactions.listTransactions",
  "transactions.getTransaction",
] as const;

const routes = implemented.map((id) => {
  const operation = operationCatalog.byId.get(id);
  if (operation === undefined) throw new Error(`Missing canonical operation ${id}`);
  return operation;
});

/** Match implemented Cloudflare adapters against paths and methods derived from the canonical API. */
// @effect-diagnostics-next-line missingPipeableSignature:off
export const transactionRoute = (path: string, method: string): Option.Option<CatalogOperation> =>
  Option.fromUndefinedOr(
    routes.find((operation) => operation.method === method && matches(operation.route, path))
  );

/** True only for paths backed by an implemented canonical Transaction adapter. */
export const ownsTransactionPath = (path: string): boolean =>
  routes.some((operation) => matches(operation.route, path));

/** Published HTTP methods for the matched canonical path, not a parallel route registry. */
export const transactionMethods = (path: string): ReadonlyArray<string> =>
  routes
    .filter(({ method }) => Option.isSome(transactionRoute(path, method)))
    .map(({ method }) => method);
