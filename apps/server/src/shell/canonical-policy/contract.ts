import { Context, Option, Schema, SchemaTransformation } from "effect";
import { OpenApi } from "effect/http-api";
import { CanonicalCapability } from "~/core/canonical-operations/contract";
import type { AccessTier } from "~/core/access-tier/contract";

export const AgentConfirmation = Schema.Literals(["not-required", "required"]);
export type AgentConfirmation = typeof AgentConfirmation.Type;

export const AtomicBatchEligible = Context.Reference<boolean>(
  "@fidy/server/shell/operation-policy/AtomicBatchEligible",
  { defaultValue: () => true }
);

export const CanonicalOperationKind = Schema.Literals(["query", "mutation"]);
export type CanonicalOperationKind = typeof CanonicalOperationKind.Type;

export const UserOwnedAgentScopeCheck = Schema.Union([
  Schema.TaggedStruct("Operation", { capability: CanonicalCapability }),
  Schema.TaggedStruct("Children", {}),
]);
export type UserOwnedAgentScopeCheck = typeof UserOwnedAgentScopeCheck.Type;

const CanonicalOperationAccess = Schema.Union([
  Schema.TaggedStruct("UserOwnedAgentScoped", { scope: UserOwnedAgentScopeCheck }),
  Schema.TaggedStruct("FreshWebSessionOnly", {}),
  Schema.TaggedStruct("WebSessionOnly", {}),
  Schema.TaggedStruct("WebOrHosted", {}),
  Schema.TaggedStruct("VerifiedWhatsAppHostedOnly", {}),
  Schema.TaggedStruct("FreshWebOrVerifiedWhatsAppHosted", {}),
]);

const PublishedOperationAccessWire = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("user-owned-agent-scoped"),
    scope: Schema.Union([
      Schema.Struct({
        evaluation: Schema.Literal("operation"),
        capability: CanonicalCapability,
      }),
      Schema.Struct({ evaluation: Schema.Literal("children") }),
    ]),
  }),
  Schema.Struct({ type: Schema.Literal("fresh-web-session-only") }),
  Schema.Struct({ type: Schema.Literal("web-session-only") }),
  Schema.Struct({ type: Schema.Literal("web-or-hosted") }),
  Schema.Struct({ type: Schema.Literal("verified-whatsapp-hosted-only") }),
  Schema.Struct({ type: Schema.Literal("fresh-web-or-verified-whatsapp-hosted") }),
]);

type CanonicalOperationAccess = typeof CanonicalOperationAccess.Type;
type PublishedOperationAccessWire = typeof PublishedOperationAccessWire.Type;

const decodePublishedAccess = (access: PublishedOperationAccessWire): CanonicalOperationAccess => {
  switch (access.type) {
    case "user-owned-agent-scoped":
      return {
        _tag: "UserOwnedAgentScoped",
        scope:
          access.scope.evaluation === "operation"
            ? { _tag: "Operation", capability: access.scope.capability }
            : { _tag: "Children" },
      };
    case "fresh-web-session-only":
      return { _tag: "FreshWebSessionOnly" };
    case "web-session-only":
      return { _tag: "WebSessionOnly" };
    case "web-or-hosted":
      return { _tag: "WebOrHosted" };
    case "verified-whatsapp-hosted-only":
      return { _tag: "VerifiedWhatsAppHostedOnly" };
    case "fresh-web-or-verified-whatsapp-hosted":
      return { _tag: "FreshWebOrVerifiedWhatsAppHosted" };
  }
};

const encodePublishedAccess = (access: CanonicalOperationAccess): PublishedOperationAccessWire => {
  switch (access._tag) {
    case "UserOwnedAgentScoped":
      return {
        type: "user-owned-agent-scoped",
        scope:
          access.scope._tag === "Operation"
            ? { evaluation: "operation", capability: access.scope.capability }
            : { evaluation: "children" },
      };
    case "FreshWebSessionOnly":
      return { type: "fresh-web-session-only" };
    case "WebSessionOnly":
      return { type: "web-session-only" };
    case "WebOrHosted":
      return { type: "web-or-hosted" };
    case "VerifiedWhatsAppHostedOnly":
      return { type: "verified-whatsapp-hosted-only" };
    case "FreshWebOrVerifiedWhatsAppHosted":
      return { type: "fresh-web-or-verified-whatsapp-hosted" };
  }
};

export const OperationAccess = PublishedOperationAccessWire.pipe(
  Schema.decodeTo(
    CanonicalOperationAccess,
    SchemaTransformation.transform({
      decode: decodePublishedAccess,
      encode: encodePublishedAccess,
    })
  )
);
export type OperationAccess = typeof OperationAccess.Type;

export const PublishedOperationAccess = Schema.toEncoded(OperationAccess);
export type PublishedOperationAccess = typeof PublishedOperationAccess.Type;

export type CanonicalAuthorityRoot = "verified-whatsapp" | "no-verified-whatsapp-authority";

export type OperationAccessCaller =
  | Readonly<{ _tag: "PAT" | "OAuthAgent"; capabilities: ReadonlyArray<CanonicalCapability> }>
  | Readonly<{ _tag: "WebSession"; fresh: boolean }>
  | Readonly<{
      _tag: "HostedAgentSession";
      authorityRoot: CanonicalAuthorityRoot;
    }>;

export type OperationAccessDenial =
  | "user_owned_agent_scope_missing"
  | "fresh_web_session_required"
  | "caller_ineligible";

export type OperationAccessDecision =
  | Readonly<{ _tag: "Allowed" }>
  | Readonly<{ _tag: "Denied"; reason: OperationAccessDenial }>;

export const userOwnedAgentScoped = (capability: CanonicalCapability): OperationAccess => ({
  _tag: "UserOwnedAgentScoped",
  scope: { _tag: "Operation", capability },
});

export const userOwnedAgentScopedChildren: OperationAccess = {
  _tag: "UserOwnedAgentScoped",
  scope: { _tag: "Children" },
};

export const freshWebSessionOnly: OperationAccess = { _tag: "FreshWebSessionOnly" };

export const webSessionOnly: OperationAccess = { _tag: "WebSessionOnly" };

export const webOrHosted: OperationAccess = { _tag: "WebOrHosted" };

export const verifiedWhatsAppHostedOnly: OperationAccess = {
  _tag: "VerifiedWhatsAppHostedOnly",
};

export const freshWebOrVerifiedWhatsAppHosted: OperationAccess = {
  _tag: "FreshWebOrVerifiedWhatsAppHosted",
};

const encodeOperationAccess = Schema.encodeSync(OperationAccess);

export const publishOperationAccess = (access: OperationAccess): PublishedOperationAccess =>
  encodeOperationAccess(access);

export const isUserOwnedAgentScoped = (access: OperationAccess): boolean =>
  access._tag === "UserOwnedAgentScoped";

const scopeCapability = (scope: UserOwnedAgentScopeCheck): Option.Option<CanonicalCapability> =>
  scope._tag === "Operation" ? Option.some(scope.capability) : Option.none();

export const userOwnedAgentCapability = (
  access: OperationAccess
): Option.Option<CanonicalCapability> => {
  if (access._tag !== "UserOwnedAgentScoped") return Option.none();
  return scopeCapability(access.scope);
};

export type OperationPolicyValue = {
  readonly access: OperationAccess;
  readonly requiredTier: AccessTier;
  readonly agentConfirmation: AgentConfirmation;
  readonly kind: CanonicalOperationKind;
};

export class OperationPolicy extends Context.Service<OperationPolicy, OperationPolicyValue>()(
  "@fidy/server/shell/canonical-policy/contract/OperationPolicy"
) {}

type PolicyAnnotatedOperation = {
  readonly annotations: Context.Context<never>;
};

export const getOperationPolicy = (endpoint: PolicyAnnotatedOperation): OperationPolicyValue =>
  Option.getOrThrow(Context.getOption(endpoint.annotations, OperationPolicy));

export const operationPolicy = (
  policy: OperationPolicyValue
): Context.Context<OperationPolicy | OpenApi.Override> =>
  Context.make(OperationPolicy, policy).pipe(
    Context.add(OpenApi.Override, {
      "x-fidy-access": publishOperationAccess(policy.access),
      "x-fidy-required-tier": policy.requiredTier,
      "x-fidy-agent-confirmation": policy.agentConfirmation,
      "x-fidy-operation-kind": policy.kind,
    })
  );
