import { DateTime, Effect, Function, type Option, Schema } from "effect";
import type { CanonicalCapability } from "~/core/_shared/canonical-capability";
import type { AccessTier } from "~/core/_shared/access-tier";
import { type OperationId, operationCatalog } from "~/shell/api";
import { type CanonicalCaller, ResolvedCaller, toAccessCaller } from "./authz";
import { resolveAccessTierInScope } from "./access-tier";
import type { CanonicalInput } from "./canonical-input";
import {
  type OperationAccessCaller,
  type OperationPolicyValue,
  decideOperationAccess,
} from "./operation-policy";
import { type PartialInput } from "./partial-input";
import {
  NextOperations,
  SuggestedOperation,
  type SuggestedOperation as SuggestedOperationValue,
} from "./response";

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

/** Resolves the owner and current AccessTier inside the canonical User-scoped transaction. */
export const resolveSuggestedOperationCaller = Effect.gen(function* () {
  const resolved = yield* ResolvedCaller;
  const tier = yield* resolveAccessTierInScope(resolved.subjectUserId, yield* DateTime.now);
  return {
    userId: resolved.subjectUserId,
    caller: toSuggestedOperationCaller({ resolved, accessTier: tier }),
  };
});

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
