import { Context, Option, Schema } from "effect";
import { OpenApi } from "effect/unstable/httpapi";
import { type AgentScope } from "~/core/tokens/model";

/** The Subscription tier a caller currently has or an operation requires. */
export const OperationTier = Schema.Literals(["free", "pro"]);
export type OperationTier = typeof OperationTier.Type;

/** Whether a hosted agent must obtain exact User confirmation before execution. */
export const AgentConfirmation = Schema.Literals(["not-required", "required"]);
export type AgentConfirmation = typeof AgentConfirmation.Type;

/** Whether an operation observes domain state or requests a transition, durable work, or external effect. */
export const CanonicalOperationKind = Schema.Literals(["query", "mutation"]);
export type CanonicalOperationKind = typeof CanonicalOperationKind.Type;

/** Route-independent authorization, availability, accounting, and agent policy carried by an operation. */
export type OperationPolicyValue = {
  readonly requiredScope: AgentScope;
  /** Whether authorization checks this endpoint or each schema-derived child operation. */
  readonly scopeEvaluation: "endpoint" | "children";
  readonly requiredTier: OperationTier;
  readonly agentConfirmation: AgentConfirmation;
  readonly kind: CanonicalOperationKind;
};

/** Annotation key read by shared authorization from the active endpoint. */
export class OperationPolicy extends Context.Service<OperationPolicy, OperationPolicyValue>()(
  "fidy-ai/shell/_shared/operation-policy/OperationPolicy"
) {}

type PolicyAnnotatedOperation = {
  readonly annotations: Context.Context<never>;
};

/**
 * Reads the complete policy directly from one canonical operation definition.
 * The caller must pass an endpoint carrying `operationPolicy`; absence is a
 * programmer defect and throws rather than silently granting a default policy.
 */
export const getOperationPolicy = (endpoint: PolicyAnnotatedOperation): OperationPolicyValue =>
  Option.getOrThrow(Context.getOption(endpoint.annotations, OperationPolicy));

/**
 * Builds the full policy annotation context for one canonical operation. The
 * runtime policy and generated OpenAPI extensions are created together so they
 * cannot drift into separate route maps.
 */
type OperationPolicyInput = Omit<OperationPolicyValue, "scopeEvaluation">;

const makeOperationPolicy = (
  { requiredScope, requiredTier, agentConfirmation, kind }: OperationPolicyInput,
  scopeEvaluation: OperationPolicyValue["scopeEvaluation"]
): Context.Context<OperationPolicy | OpenApi.Override> =>
  Context.make(OperationPolicy, {
    requiredScope,
    scopeEvaluation,
    requiredTier,
    agentConfirmation,
    kind,
  }).pipe(
    Context.add(OpenApi.Override, {
      "x-fidy-required-scope": requiredScope,
      "x-fidy-required-tier": requiredTier,
      "x-fidy-agent-confirmation": agentConfirmation,
      "x-fidy-operation-kind": kind,
    })
  );

export const operationPolicy = (
  policy: OperationPolicyInput
): Context.Context<OperationPolicy | OpenApi.Override> => makeOperationPolicy(policy, "endpoint");

/** Policy constructor reserved for operations whose children carry authoritative scopes. */
export const childScopeOperationPolicy = (
  policy: OperationPolicyInput
): Context.Context<OperationPolicy | OpenApi.Override> => makeOperationPolicy(policy, "children");
