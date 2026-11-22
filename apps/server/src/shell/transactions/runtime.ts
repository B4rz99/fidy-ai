import { Option } from "effect";
import { operationCatalog } from "~/shell/api";
import type { CatalogOperation } from "~/shell/canonical-catalog/contract";
import { matchesRouteTemplate } from "~/shell/public-http/operations";

const implemented = [
  "transactions.createTransaction",
  "transactions.updateTransactions",
  "transactions.listTransactions",
  "transactions.searchTransactions",
  "transactions.getTransaction",
  "transactions.linkTransactions",
  "transactions.unlinkTransactions",
  "transactions.updateTransaction",
  "transactions.deleteTransaction",
] as const;

const routes = implemented.map((id) => {
  const operation = operationCatalog.byId.get(id);

  if (operation === undefined) throw new Error(`Missing canonical operation ${id}`);

  return operation;
});

export const transactionRoute = ({
  path,
  method,
}: Readonly<{ path: string; method: string }>): Option.Option<CatalogOperation> =>
  Option.fromUndefinedOr(
    routes.find(
      (operation) =>
        operation.method === method && matchesRouteTemplate({ template: operation.route, path })
    )
  );

export const ownsTransactionPath = (path: string): boolean =>
  routes.some((operation) => matchesRouteTemplate({ template: operation.route, path }));

export const transactionMethods = (path: string): ReadonlyArray<string> =>
  routes.flatMap(({ method }) =>
    Option.toArray(Option.as(transactionRoute({ path, method }), method))
  );
