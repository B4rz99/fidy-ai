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
import type { OperationId } from "~/shell/api";

import { type CanonicalInput } from "./contract";
import {
  OperationAccessCaller,
  OperationAccessDecision,
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

export const checkpointResponseSuggestions: typeof responseSuggestions = (input) =>
  responseSuggestions(input);

type CandidateArgs<Id extends OperationId> = keyof CanonicalInput<Id> extends never
  ? Record<never, never>
  : { readonly args: Option.Option<PartialInput<CanonicalInput<Id>>> };

export type SuggestedOperationCandidate<Id extends OperationId = OperationId> =
  Id extends OperationId
    ? {
        readonly tool: Id;
        readonly hint: string;
      } & CandidateArgs<Id>
    : never;

export const suggestOperation = <Id extends OperationId>(
  candidate: SuggestedOperationCandidate<Id>
): SuggestedOperationCandidate<Id> => candidate;

export type SuggestedOperationCaller = {
  readonly accessCaller: OperationAccessCaller;
  readonly tier: AccessTier;
};

export const freePatCaller = (
  capabilities: ReadonlyArray<CanonicalCapability>
): SuggestedOperationCaller => ({
  accessCaller: OperationAccessCaller.PAT({ capabilities }),
  tier: "free",
});

export const grantsRequiredTier = (input: {
  readonly requiredTier: AccessTier;
  readonly callerTier: AccessTier;
}): boolean => input.requiredTier === "free" || input.callerTier === "pro";

export const canCallOperation: {
  (caller: SuggestedOperationCaller): (self: OperationPolicyValue) => boolean;
  (self: OperationPolicyValue, caller: SuggestedOperationCaller): boolean;
} = Function.dual(
  2,
  (self: OperationPolicyValue, caller: SuggestedOperationCaller): boolean =>
    OperationAccessDecision.$is("Allowed")(
      decideOperationAccess(self.access, caller.accessCaller)
    ) && grantsRequiredTier({ requiredTier: self.requiredTier, callerTier: caller.tier })
);

const validationOptions = {
  errors: "all",
  onExcessProperty: "error",
} as const;

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
    const target = getBoundOperationCatalog().byId.get(candidate.tool);

    if (target === undefined) {
      throw new Error(`Unknown canonical operation id: ${candidate.tool}`);
    }

    return canCallOperation(target.policy, caller);
  });

  Schema.encodeUnknownSync(NextOperations, validationOptions)(available);

  return available;
};

export const getCanonicalOperationInput = <Id extends OperationId>(
  id: Id
): Schema.Codec<CanonicalInput<Id>, Schema.Json> =>
  Schema.suspend(() => {
    const operation = getBoundOperationCatalog().byId.get(id);

    if (operation === undefined) throw new Error(`Unknown canonical operation: ${id}`);

    return Schema.make<Schema.Codec<CanonicalInput<Id>, Schema.Json>>(operation.input.ast);
  });

const maximumHostedOperationWireNameLength = 64;

export const HostedOperationWireName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
  Schema.isMaxLength(maximumHostedOperationWireNameLength)
).pipe(Schema.brand("HostedOperationWireName"));

export type HostedOperationWireName = typeof HostedOperationWireName.Type;

export type HostedOperationBinding = Readonly<{
  readonly operation: CatalogOperation;
  readonly wireName: HostedOperationWireName;
}>;

export const encodeHostedOperationWireName = (
  operation: CanonicalOperationId
): HostedOperationWireName => HostedOperationWireName.make(operation.replaceAll(".", "__"));

export const hostedConfirmationGuidance = (
  confirmation: CatalogOperation["policy"]["agentConfirmation"]
): string =>
  confirmation === "not-required"
    ? " This operation does not require User confirmation; call it directly without asking the User to confirm."
    : " The host manages exact confirmation for this operation; call the tool rather than asking the User for informal confirmation.";

export const hostedToolDescription = (operation: CatalogOperation): string =>
  operation.description + hostedConfirmationGuidance(operation.policy.agentConfirmation);

export const hostedOperationBindings = (
  catalog: OperationCatalog
): ReadonlyArray<HostedOperationBinding> =>
  catalog.operations
    .filter((operation) => isHostedVisible(operation.policy.access, "verified-whatsapp"))
    .map((operation) => ({
      operation,
      wireName: encodeHostedOperationWireName(operation.id),
    }));
