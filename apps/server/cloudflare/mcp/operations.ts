import { nativeCanonicalOperations } from "../canonical-operations/operations";
import type { CatalogOperation } from "../../src/shell/canonical-catalog/contract";

export const nativeMcpCatalog = (): ReadonlyArray<CatalogOperation> =>
  nativeCanonicalOperations().filter(
    ({ id }) => id !== "identity.getCurrentUser" && id !== "identity.updateUserPreferences"
  );
