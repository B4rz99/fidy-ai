import { Context, Option, Schema } from "effect";
import { OpenApi } from "effect/unstable/httpapi";
import { type AgentScope } from "~/core/tokens/model";

/** Cost category declared by a canonical operation for later quota enforcement. */
export const OperationCostClass = Schema.Literals(["cheap", "expensive"]);
export type OperationCostClass = typeof OperationCostClass.Type;

/** Route-independent authorization and accounting policy carried by an operation. */
export interface OperationPolicyValue {
  readonly requiredScope: AgentScope;
  readonly costClass: OperationCostClass;
}

/** Annotation key read by shared authorization from the active endpoint. */
export class OperationPolicy extends Context.Service<OperationPolicy, OperationPolicyValue>()(
  "fidy-ai/shell/_shared/operation-policy/OperationPolicy"
) {}

interface PolicyAnnotatedOperation {
  readonly annotations: Context.Context<never>;
}

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
export const operationPolicy = ({
  requiredScope,
  costClass,
}: OperationPolicyValue): Context.Context<OperationPolicy | OpenApi.Override> =>
  Context.make(OperationPolicy, { requiredScope, costClass }).pipe(
    Context.add(OpenApi.Override, {
      "x-fidy-required-scope": requiredScope,
      "x-fidy-cost-class": costClass,
    })
  );
