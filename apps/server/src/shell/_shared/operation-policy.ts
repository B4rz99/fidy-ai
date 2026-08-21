import { Context, Option, Schema } from "effect";
import { OpenApi } from "effect/unstable/httpapi";
import type { CanonicalCapability } from "~/core/_shared/canonical-capability";

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
  readonly requiredCapability: CanonicalCapability;
  /** Whether authorization checks this canonical operation or each schema-derived child operation. */
  readonly capabilityEvaluation: "operation" | "children";
  readonly requiredTier: OperationTier;
  readonly agentConfirmation: AgentConfirmation;
  readonly kind: CanonicalOperationKind;
};

/** Annotation key read by shared authorization from the active endpoint. */
export class OperationPolicy extends Context.Service<OperationPolicy, OperationPolicyValue>()(
  "@fidy/server/shell/_shared/operation-policy/OperationPolicy"
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
type OperationPolicyInput = Omit<OperationPolicyValue, "capabilityEvaluation">;

const makeOperationPolicy = (
  { requiredCapability, requiredTier, agentConfirmation, kind }: OperationPolicyInput,
  capabilityEvaluation: OperationPolicyValue["capabilityEvaluation"]
): Context.Context<OperationPolicy | OpenApi.Override> =>
  Context.make(OperationPolicy, {
    requiredCapability,
    capabilityEvaluation,
    requiredTier,
    agentConfirmation,
    kind,
  }).pipe(
    Context.add(OpenApi.Override, {
      "x-fidy-required-scope": requiredCapability,
      "x-fidy-required-tier": requiredTier,
      "x-fidy-agent-confirmation": agentConfirmation,
      "x-fidy-operation-kind": kind,
    })
  );

export const operationPolicy = (
  policy: OperationPolicyInput
): Context.Context<OperationPolicy | OpenApi.Override> => makeOperationPolicy(policy, "operation");

/** Policy constructor reserved for operations whose children carry authoritative capabilities. */
export const childCapabilityOperationPolicy = (
  policy: OperationPolicyInput
): Context.Context<OperationPolicy | OpenApi.Override> => makeOperationPolicy(policy, "children");
