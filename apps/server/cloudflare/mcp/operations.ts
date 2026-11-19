import { nativeCanonicalOperations } from "../canonical-operations/operations";
import type { CatalogOperation } from "../../src/shell/canonical-catalog/contract";

/** MCP's installed tool contract excludes the direct User profile and preferences operations. */
export const nativeMcpCatalog = (): ReadonlyArray<CatalogOperation> =>
  nativeCanonicalOperations().filter(
    ({ id }) => id !== "identity.getCurrentUser" && id !== "identity.updateUserPreferences"
  );
