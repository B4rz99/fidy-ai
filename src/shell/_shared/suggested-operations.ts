import { type Option, Schema } from "effect";
import { type HttpApiEndpoint } from "effect/unstable/httpapi";
import { type AgentScope } from "~/core/tokens/model";
import { type FidyApi, type OperationId, operationCatalog } from "~/shell/api";
import { type OperationPolicyValue, type OperationTier } from "./operation-policy";
import { type PartialInput } from "./partial-input";
import {
  NextOperations,
  SuggestedOperation,
  type SuggestedOperation as SuggestedOperationValue,
} from "./response";

type EndpointFor<Id extends OperationId> = Id extends `${infer Group}.${infer Endpoint}`
  ? Group extends keyof typeof FidyApi.groups
    ? Endpoint extends keyof (typeof FidyApi.groups)[Group]["endpoints"]
      ? (typeof FidyApi.groups)[Group]["endpoints"][Endpoint]
      : never
    : never
  : never;

type ClientInput<Endpoint extends HttpApiEndpoint.ConstraintRequest> = Exclude<
  HttpApiEndpoint.ClientRequest<
    Endpoint["~Params"],
    Endpoint["~Query"],
    Endpoint["~Payload"],
    Endpoint["~Headers"],
    "decoded-only"
  >,
  void
>;

type CanonicalInput<Id extends OperationId> = Omit<ClientInput<EndpointFor<Id>>, "responseMode">;

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
  readonly scopes: ReadonlyArray<AgentScope>;
  readonly tier: OperationTier;
};

/** Converts the current free-tier authorization facts into suggestion checkpoint input. */
export const makeFreeSuggestedOperationCaller = (
  scopes: SuggestedOperationCaller["scopes"]
): SuggestedOperationCaller => ({ scopes, tier: "free" });

const hasRequiredTier = (requiredTier: OperationTier, callerTier: OperationTier): boolean =>
  requiredTier === "free" || callerTier === "pro";

/**
 * Decides callability from the same policy authorization and generated surfaces
 * read. `free` operations are available to both tiers; Pro operations require a
 * Pro caller, and every operation still requires its declared AgentToken scope.
 */
export const canCallOperation = ({
  policy,
  caller,
}: {
  readonly policy: OperationPolicyValue;
  readonly caller: SuggestedOperationCaller;
}): boolean =>
  caller.scopes.includes(policy.requiredScope) && hasRequiredTier(policy.requiredTier, caller.tier);

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
    return canCallOperation({ policy: target.policy, caller });
  });

  Schema.encodeUnknownSync(NextOperations, validationOptions)(available);
  return available;
};
