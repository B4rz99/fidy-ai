import { Schema } from "effect";
import type { OperationId } from "~/shell/api";
import type { CanonicalInput } from "./canonical-input";
import { getBoundOperationCatalog } from "./operation-catalog";

/**
 * Return the catalog-derived JSON input codec for one named canonical operation. The id selects
 * its decoded input type from the assembled API; absence means the catalog was assembled wrongly.
 * Generic consumers continue to use the erased `CatalogOperation.input` view.
 */
export const getCanonicalOperationInput = <Id extends OperationId>(
  id: Id
): Schema.Codec<CanonicalInput<Id>, Schema.Json> => {
  const operation = getBoundOperationCatalog().byId.get(id);
  if (operation === undefined) throw new Error(`Unknown canonical operation: ${id}`);
  return Schema.make<Schema.Codec<CanonicalInput<Id>, Schema.Json>>(operation.input.ast);
};
