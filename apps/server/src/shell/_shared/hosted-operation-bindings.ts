import { Schema } from "effect";
import type { CanonicalOperationId } from "~/core/canonical-operations/contract";
import type { CatalogOperation, OperationCatalog } from "./operation-catalog";
import { isHostedVisible } from "./operation-policy";

const maximumHostedOperationWireNameLength = 64;

/** A provider-safe toolkit wire name mechanically derived from one canonical operation id. */
export const HostedOperationWireName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
  Schema.isMaxLength(maximumHostedOperationWireNameLength)
).pipe(Schema.brand("HostedOperationWireName"));
export type HostedOperationWireName = typeof HostedOperationWireName.Type;

/** One canonical operation admitted to a hosted provider toolkit under verified WhatsApp authority. */
export type HostedOperationBinding = Readonly<{
  readonly operation: CatalogOperation;
  readonly wireName: HostedOperationWireName;
}>;

/** Encodes a canonical operation id as one provider-safe toolkit wire name. */
export const encodeHostedOperationWireName = (
  operation: CanonicalOperationId
): HostedOperationWireName => HostedOperationWireName.make(operation.replaceAll(".", "__"));

/** Provider-facing guidance for the confirmation behavior one operation policy requires. */
export const hostedConfirmationGuidance = (
  confirmation: CatalogOperation["policy"]["agentConfirmation"]
): string =>
  confirmation === "not-required"
    ? " This operation does not require User confirmation; call it directly without asking the User to confirm."
    : " The host manages exact confirmation for this operation; call the tool rather than asking the User for informal confirmation.";

/** Complete provider-facing description including the required confirmation behavior. */
export const hostedToolDescription = (operation: CatalogOperation): string =>
  operation.description + hostedConfirmationGuidance(operation.policy.agentConfirmation);

/** Every hosted-visible operation binding, derived once from one assembled canonical catalog. */
export const hostedOperationBindings = (
  catalog: OperationCatalog
): ReadonlyArray<HostedOperationBinding> =>
  catalog.operations
    .filter((operation) => isHostedVisible(operation.policy.access, "verified-whatsapp"))
    .map((operation) => ({
      operation,
      wireName: encodeHostedOperationWireName(operation.id),
    }));
