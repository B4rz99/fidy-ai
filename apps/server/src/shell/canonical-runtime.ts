/** Published canonical catalog and access decision shared by Worker routing and agent execution. */
export { operationCatalog } from "./api";
export { decideOperationAccess } from "~/shell/_shared/operation-policy";
export type { CatalogOperation } from "~/shell/_shared/operation-catalog";
export { CanonicalCapability } from "~/core/canonical-operations/contract";
export { patScopeCapability } from "~/shell/_shared/operation-policy";
