import { operationCatalog } from "~/shell/api";
import { matchesRouteTemplate } from "~/shell/_shared/route-template";
import { memoryOperationIds } from "./operations";

const routes = memoryOperationIds.map((id) => {
  const operation = operationCatalog.byId.get(id);
  if (operation === undefined) throw new Error(`Missing canonical operation ${id}`);
  return operation;
});

/** True only for paths backed by an implemented canonical Memory adapter. */
export const ownsMemoryPath = (path: string): boolean =>
  routes.some((operation) => matchesRouteTemplate({ template: operation.route, path }));
