import {
  type CatalogOperation,
  type OperationCatalog,
  getBoundOperationCatalog,
} from "~/shell/canonical-catalog/contract";
import { Function, type Option, Schema } from "effect";
import {
  type CanonicalCapability,
  type CanonicalOperationId,
} from "~/core/canonical-operations/contract";
import { type AccessTier } from "~/core/access-tier/contract";
import { type OperationId, operationCatalog } from "~/shell/api";
import { type CanonicalCaller } from "~/shell/authorization/contract";
import { toAccessCaller } from "~/shell/authorization/operations";

import { type CanonicalInput } from "./contract";
import {
  type OperationAccessCaller,
  type OperationPolicyValue,
} from "~/shell/canonical-policy/contract";
import { decideOperationAccess, isHostedVisible } from "~/shell/canonical-policy/operations";
import { type PartialInput } from "~/shell/partial-input/contract";
import {
  NextOperations,
  SuggestedOperation,
  type SuggestedOperation as SuggestedOperationValue,
} from "~/shell/public-http/contract";
import { responseSuggestions } from "~/shell/canonical-operations/internal/response-suggestions";

/** Apply caller-policy continuation privacy throughout an encoded canonical response without projecting away domain data. */
export const checkpointResponseSuggestions: typeof responseSuggestions = (input) =>
  responseSuggestions(input);

type CandidateArgs<Id extends OperationId> = keyof CanonicalInput<Id> extends never
  ? Record<never, never>
  : { readonly args: Option.Option<PartialInput<CanonicalInput<Id>>> };

/** A handler proposal whose target and known arguments are checked against `FidyApi`. */
export type SuggestedOperationCandidate<Id extends OperationId = OperationId> =
  Id extends OperationId
    ? {
        readonly tool: Id;
        readonly hint: string;
      } & CandidateArgs<Id>
    : never;

/**
 * Constructs one handler proposal. The operation id selects its argument type,
 * so a renamed operation or an argument unknown to that target is a compile
 * error at the proposal site; runtime schema validation remains the checkpoint's
 * responsibility because model- or database-derived values are still untrusted.
 */
export const suggestOperation = <Id extends OperationId>(
  candidate: SuggestedOperationCandidate<Id>
): SuggestedOperationCandidate<Id> => candidate;

/** The explicit caller facts needed to decide whether a target is callable. */
export type SuggestedOperationCaller = {
  readonly accessCaller: OperationAccessCaller;
  readonly tier: AccessTier;
};

/** Projects a canonical caller and resolved tier into suggestion-policy facts. */
export const toSuggestedOperationCaller = (input: {
  readonly resolved: CanonicalCaller;
  readonly accessTier: AccessTier;
}): SuggestedOperationCaller => ({
  accessCaller: toAccessCaller(input.resolved),
  tier: input.accessTier,
});

/** Explicit test adapter for a Free PAT with fixed capabilities. */
export const freePatCaller = (
  capabilities: ReadonlyArray<CanonicalCapability>
): SuggestedOperationCaller => ({ accessCaller: { _tag: "PAT", capabilities }, tier: "free" });

/** Whether current capabilities satisfy one canonical operation's declared tier. */
export const grantsRequiredTier = (input: {
  readonly requiredTier: AccessTier;
  readonly callerTier: AccessTier;
}): boolean => input.requiredTier === "free" || input.callerTier === "pro";

/**
 * Decides callability from the same policy authorization and generated surfaces
 * read. `free` operations are available to both tiers; Pro operations require a
 * Pro caller, and every operation still requires its declared caller-access requirement.
 */
export const canCallOperation: {
  (caller: SuggestedOperationCaller): (self: OperationPolicyValue) => boolean;
  (self: OperationPolicyValue, caller: SuggestedOperationCaller): boolean;
} = Function.dual(
  2,
  (self: OperationPolicyValue, caller: SuggestedOperationCaller): boolean =>
    decideOperationAccess(self.access, caller.accessCaller)._tag === "Allowed" &&
    grantsRequiredTier({ requiredTier: self.requiredTier, callerTier: caller.tier })
);

const validationOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

/**
 * Validates handler proposals against their target operation inputs, removes
 * targets the caller cannot invoke by scope or Subscription tier, then enforces
 * the universal three-item response cap. Invalid ids, invalid known arguments,
 * malformed hints, and a post-filter overflow are programmer defects and throw
 * before the response reaches serialization; unavailable operations alone are
 * quietly removed because that is the checkpoint's purpose.
 */
export const checkpointSuggestedOperations = ({
  candidates,
  caller,
}: {
  readonly candidates: ReadonlyArray<SuggestedOperationCandidate>;
  readonly caller: SuggestedOperationCaller;
}): ReadonlyArray<SuggestedOperationValue> => {
  const validated = candidates.map((candidate) =>
    Schema.decodeUnknownSync(Schema.toType(SuggestedOperation), validationOptions)(candidate)
  );

  const available = validated.filter((candidate) => {
    const target = operationCatalog.byId.get(candidate.tool);
    if (target === undefined) {
      throw new Error(`Unknown canonical operation id: ${candidate.tool}`);
    }
    return canCallOperation(target.policy, caller);
  });

  Schema.encodeUnknownSync(NextOperations, validationOptions)(available);
  return available;
};

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
